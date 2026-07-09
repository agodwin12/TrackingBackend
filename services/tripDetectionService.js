// services/tripDetectionService.js
const { Op } = require("sequelize");
const Location = require("../models/location");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const sequelize = require("../config/database");
const logger = require("../utils/logger");
const axios = require("axios");

// ═══════════════════════════════════════════════════════════════════════
// GOOGLE MAPS API KEY — loaded from environment variables only
// ═══════════════════════════════════════════════════════════════════════
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!GOOGLE_MAPS_API_KEY) {
    throw new Error(
        "❌ FATAL: GOOGLE_MAPS_API_KEY is not set. " +
        "Add it to your .env file before starting the server."
    );
}

// ─── Non-blocking yield helper ────────────────────────────────────────────────
// Yields control back to the Node.js event loop so HTTP requests can be
// processed between loop iterations. Called every YIELD_EVERY iterations
// inside the main detection loop.
const YIELD_EVERY = 100;
function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

class TripDetectionService {

    // ==================== CONFIGURATION ====================

    // 🚗 TRIP DETECTION THRESHOLDS
    static IDLE_THRESHOLD_MINUTES       = Number(process.env.TRIP_IDLE_MINUTES   ?? 10);
    static MIN_SPEED_THRESHOLD          = Number(process.env.TRIP_MIN_SPEED_KMH  ?? 10);
    static TRIP_MERGE_THRESHOLD_MINUTES = Number(process.env.TRIP_MERGE_MINUTES  ?? 3);

    // 🎯 MINIMUM TRIP REQUIREMENTS
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION    ?? 2);
    static MIN_TRIP_DISTANCE_KM  = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 0.5);

    // 📍 GPS DRIFT DETECTION
    static GPS_DRIFT_THRESHOLD_METERS = Number(process.env.GPS_DRIFT_METERS ?? 100);
    static MAX_PARKED_SPEED           = 3;

    // 🆕 TRIP START CONFIRMATION
    static MIN_CONSECUTIVE_MOVING_POINTS     = 3;
    static MIN_DISTANCE_TO_START_TRIP_METERS = 100;
    static PARKING_LOT_RADIUS_METERS         = 100;

    // 📐 GPS POSITION CORRECTION THRESHOLDS
    static MAX_SPEED_KMPH           = 200;
    static MAX_JUMP_DISTANCE_METERS = 1000;
    static MIN_JUMP_TIME_SECONDS    = 2;

    // ✅ FIX: was 170 — rejected valid U-turns and sharp junctions.
    // Now 179 — only rejects physically impossible GPS bounces (a point
    // that goes forward then immediately snaps back the exact same way).
    static DIRECTION_CHANGE_THRESHOLD = 179;

    // Douglas-Peucker tolerance for path simplification (degrees).
    // 0.0001° ≈ 11m at Cameroon latitude — safe for city roads.
    static DOUGLAS_PEUCKER_TOLERANCE = 0.0001;

    // ⚡ PERFORMANCE SETTINGS
    static MAX_LOCATIONS_PER_BATCH = Number(process.env.TRIP_MAX_LOCATIONS_BATCH ?? 2000);
    static WAYPOINT_BATCH_SIZE     = Number(process.env.TRIP_WAYPOINT_BATCH_SIZE  ?? 1000);

    // ==================== REVERSE GEOCODING ====================

    static async reverseGeocode(latitude, longitude) {
        try {
            const response = await axios.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                {
                    params:  { latlng: `${latitude},${longitude}`, key: GOOGLE_MAPS_API_KEY, language: "en" },
                    timeout: 10000
                }
            );

            const { status, results } = response.data;

            if (status === "ZERO_RESULTS") {
                return { address: "Unknown Location", status: "failed", success: false };
            }
            if (status === "OVER_QUERY_LIMIT") {
                logger.warn("[GEOCODE] Google Maps API quota exceeded");
                return { address: "Location unavailable (rate limit)", status: "failed", success: false };
            }
            if (status === "REQUEST_DENIED") {
                logger.error("[GEOCODE] Request denied — check API key restrictions");
                return { address: "Location unavailable (API error)", status: "failed", success: false };
            }
            if (status === "INVALID_REQUEST") {
                logger.error("[GEOCODE] Invalid request");
                return { address: "Location unavailable (invalid request)", status: "failed", success: false };
            }
            if (status === "UNKNOWN_ERROR") {
                logger.warn("[GEOCODE] Unknown server error — will retry later");
                return { address: "Location unavailable (server error)", status: "failed", success: false };
            }

            if (status === "OK" && results && results.length > 0) {
                const result = results[0];

                let neighborhood = null, locality = null, sublocality = null;
                let route = null, administrativeArea = null;

                for (const component of result.address_components) {
                    if (component.types.includes("neighborhood"))                                         neighborhood = component.long_name;
                    else if (component.types.includes("route"))                                           route        = component.long_name;
                    else if (component.types.includes("sublocality") ||
                        component.types.includes("sublocality_level_1"))                             sublocality  = component.long_name;
                    else if (component.types.includes("locality"))                                        locality     = component.long_name;
                    else if (component.types.includes("administrative_area_level_2") && !locality)        administrativeArea = component.long_name;
                    else if (component.types.includes("administrative_area_level_1") &&
                        !locality && !administrativeArea)                                            administrativeArea = component.long_name;
                }

                let address;
                if      (route && locality)    address = `${route}, ${locality}`;
                else if (route && sublocality) address = `${route}, ${sublocality}`;
                else if (route)                address = route;
                else if (sublocality)          address = sublocality;
                else if (neighborhood)         address = neighborhood;
                else if (locality)             address = locality;
                else if (administrativeArea)   address = administrativeArea;
                else                           address = result.formatted_address.split(",")[0];

                logger.debug(`[GEOCODE] [${latitude}, ${longitude}] → "${address}"`);
                return { address: address || "Unknown Location", status: "geocoded", success: true };
            }

            logger.warn(`[GEOCODE] Unexpected status: ${status}`);
            return { address: "Location unavailable", status: "failed", success: false };

        } catch (error) {
            if      (error.code === "ECONNABORTED") logger.error("[GEOCODE] Timeout — Google Maps API too slow");
            else if (error.code === "ENOTFOUND")    logger.error("[GEOCODE] DNS error — cannot reach maps.googleapis.com");
            else if (error.code === "ECONNREFUSED") logger.error("[GEOCODE] Connection refused — check network/firewall");
            else                                    logger.error(`[GEOCODE] Exception for [${latitude}, ${longitude}]: ${error.message}`);

            return { address: "Location unavailable", status: "failed", success: false };
        }
    }

    // ==================== MAIN ENTRY POINT ====================

    static async detectAndCreateTrips() {
        logger.info("[TRIP DETECTION] === START ===");

        try {
            const macs = await this.getVehiclesWithUnprocessedData();

            if (macs.length === 0) {
                logger.debug("[TRIP DETECTION] No vehicles with unprocessed data — idle");
                return { success: true, tripsCreated: 0, vehiclesProcessed: 0 };
            }

            logger.info(`[TRIP DETECTION] ${macs.length} vehicle(s) with unprocessed data`);

            let totalTrips  = 0;
            let mergedTrips = 0;
            let skipped     = 0;
            let errors      = 0;

            // Sequential processing — concurrency is handled at the cron level
            // via processVehiclesConcurrently() in tripDetectionCron.js.
            // This method is kept simple so it can also be called directly.
            for (const mac of macs) {
                try {
                    const res = await this.processVehicleLocations(mac);
                    if (res.skipped)      skipped++;
                    totalTrips  += res.tripsCreated  || 0;
                    mergedTrips += res.tripsMerged   || 0;
                } catch (error) {
                    logger.error(`[TRIP DETECTION] Vehicle ${mac} failed: ${error.message}`);
                    errors++;
                }
            }

            logger.info("[TRIP DETECTION] === COMPLETE ===", {
                tripsCreated:      totalTrips,
                tripsMerged:       mergedTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped:   skipped,
                errors
            });

            return {
                success:           true,
                tripsCreated:      totalTrips,
                tripsMerged:       mergedTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped:   skipped,
                errors
            };

        } catch (error) {
            logger.error(`[TRIP DETECTION] Fatal error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    static async getVehiclesWithUnprocessedData() {
        try {
            const rows = await Location.findAll({
                where:      { processed: false },
                attributes: [[sequelize.fn("DISTINCT", sequelize.col("mac_id_gps")), "mac_id_gps"]],
                raw:        true
            });
            return rows.map(r => r.mac_id_gps).filter(Boolean);
        } catch (error) {
            logger.error(`[TRIP DETECTION] Error fetching unprocessed vehicles: ${error.message}`);
            return [];
        }
    }

    // ==================== GPS VALIDATION ====================

    static isValidGPSPoint(currentLoc, lastValidLoc, timeDiff) {
        if (!lastValidLoc) return true;

        const distance = this.calculateHaversineDistance(
            lastValidLoc.latitude, lastValidLoc.longitude,
            currentLoc.latitude,   currentLoc.longitude
        ) * 1000; // metres

        if (timeDiff > this.MIN_JUMP_TIME_SECONDS) {
            const speed = (distance / 1000) / (timeDiff / 3600);
            if (speed > this.MAX_SPEED_KMPH) {
                logger.debug(`[GPS VALIDATE] Outlier rejected: ${speed.toFixed(1)} km/h > max ${this.MAX_SPEED_KMPH}`);
                return false;
            }
        }

        if (distance > this.MAX_JUMP_DISTANCE_METERS && timeDiff < 10) {
            logger.debug(`[GPS VALIDATE] Outlier rejected: ${distance.toFixed(0)}m jump in ${timeDiff.toFixed(1)}s`);
            return false;
        }

        return true;
    }

    static isConsistentDirection(prevLoc, currentLoc, nextLoc) {
        if (!prevLoc || !nextLoc) return true;

        const bearing1 = this.calculateBearing(
            prevLoc.latitude,    prevLoc.longitude,
            currentLoc.latitude, currentLoc.longitude
        );
        const bearing2 = this.calculateBearing(
            currentLoc.latitude, currentLoc.longitude,
            nextLoc.latitude,    nextLoc.longitude
        );

        let angleDiff = Math.abs(bearing2 - bearing1);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;

        // ✅ FIX: threshold raised from 170° → 179°
        // At 170° valid U-turns (≈180°) and sharp junctions (≈160°) were
        // being rejected as "inconsistent direction", creating gaps in the
        // route. Now only physically impossible GPS bounces are filtered out.
        if (angleDiff > this.DIRECTION_CHANGE_THRESHOLD) {
            const distance = this.calculateHaversineDistance(
                prevLoc.latitude, prevLoc.longitude,
                nextLoc.latitude, nextLoc.longitude
            ) * 1000;

            if (distance > 50) {
                logger.debug(`[GPS VALIDATE] Direction inconsistency: ${angleDiff.toFixed(0)}° change`);
                return false;
            }
        }

        return true;
    }

    static calculateBearing(lat1, lon1, lat2, lon2) {
        const dLon = this.toRadians(lon2 - lon1);
        const y    = Math.sin(dLon) * Math.cos(this.toRadians(lat2));
        const x    = Math.cos(this.toRadians(lat1)) * Math.sin(this.toRadians(lat2)) -
            Math.sin(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.cos(dLon);
        return (this.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }

    // ==================== PATH PROCESSING ====================

    static simplifyPath(points, tolerance = this.DOUGLAS_PEUCKER_TOLERANCE) {
        if (points.length <= 2) return points;

        const pointToSegmentDistance = (point, start, end) => {
            const [x, y]   = [point.longitude, point.latitude];
            const [x1, y1] = [start.longitude, start.latitude];
            const [x2, y2] = [end.longitude,   end.latitude];

            const A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
            const dot   = A * C + B * D;
            const lenSq = C * C + D * D;
            const param = lenSq !== 0 ? dot / lenSq : -1;

            const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
            const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;

            return Math.sqrt((x - xx) ** 2 + (y - yy) ** 2);
        };

        const douglasPeucker = (pts, epsilon) => {
            if (pts.length <= 2) return pts;

            let maxDistance = 0, index = 0;
            for (let i = 1; i < pts.length - 1; i++) {
                const d = pointToSegmentDistance(pts[i], pts[0], pts[pts.length - 1]);
                if (d > maxDistance) { maxDistance = d; index = i; }
            }

            if (maxDistance > epsilon) {
                const left  = douglasPeucker(pts.slice(0, index + 1), epsilon);
                const right = douglasPeucker(pts.slice(index), epsilon);
                return left.slice(0, -1).concat(right);
            }
            return [pts[0], pts[pts.length - 1]];
        };

        return douglasPeucker(points, tolerance);
    }

    // ✅ smoothPath is kept as a utility but is NO LONGER called before saving
    // waypoints to the DB. Smoothing shifts coordinates off their true GPS
    // position, which degrades OSRM road-snapping quality at display time.
    // It may still be used for display-only calculations if needed in future.
    static smoothPath(waypoints, windowSize = 3) {
        if (waypoints.length < windowSize) return waypoints;

        const smoothed = [waypoints[0]];

        for (let i = 1; i < waypoints.length - 1; i++) {
            const start  = Math.max(0, i - Math.floor(windowSize / 2));
            const end    = Math.min(waypoints.length, i + Math.floor(windowSize / 2) + 1);
            const window = waypoints.slice(start, end);

            smoothed.push({
                ...waypoints[i],
                latitude:  window.reduce((s, w) => s + parseFloat(w.latitude),   0) / window.length,
                longitude: window.reduce((s, w) => s + parseFloat(w.longitude),  0) / window.length,
                speed:     window.reduce((s, w) => s + parseFloat(w.speed || 0), 0) / window.length
            });
        }

        smoothed.push(waypoints[waypoints.length - 1]);
        return smoothed;
    }

    // ==================== VEHICLE PROCESSING ====================

    static async processVehicleLocations(macIdGps) {
        try {
            const locationCount = await Location.count({
                where: { mac_id_gps: macIdGps, processed: false }
            });

            if (locationCount === 0) {
                return { skipped: false, tripsCreated: 0, tripsMerged: 0 };
            }

            logger.info(`[TRIP DETECTION] Vehicle ${macIdGps}: ${locationCount} unprocessed location(s)`);

            const vehicle = await Voiture.findOne({
                where:      { mac_id_gps: macIdGps },
                attributes: ["id", "immatriculation"],
                raw:        true
            });

            if (!vehicle) {
                logger.warn(`[TRIP DETECTION] No vehicle found for MAC ${macIdGps} — marking locations processed`);
                await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps, processed: false } });
                return { skipped: false, tripsCreated: 0, tripsMerged: 0 };
            }

            const userCheck = await this.checkUserTripTracking(vehicle.id);

            if (!userCheck.enabled) {
                logger.debug(`[TRIP DETECTION] Tracking disabled for vehicle ${vehicle.id}: ${userCheck.reason}`);
                await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps, processed: false } });
                return { skipped: true, tripsCreated: 0, tripsMerged: 0 };
            }

            const ongoingTrip = await this.getOngoingTrip(vehicle.id, macIdGps);

            let totalTripsProcessed = 0;
            let totalTripsMerged    = 0;

            if (locationCount > this.MAX_LOCATIONS_PER_BATCH) {
                logger.info(`[TRIP DETECTION] Large set (${locationCount} locations) — processing in batches of ${this.MAX_LOCATIONS_PER_BATCH}`);

                let offset      = 0;
                let currentTrip = ongoingTrip;

                while (offset < locationCount) {
                    const locations = await Location.findAll({
                        where:  { mac_id_gps: macIdGps, processed: false },
                        order:  [["sys_time", "ASC"]],
                        limit:  this.MAX_LOCATIONS_PER_BATCH,
                        offset,
                        raw:    true
                    });

                    if (locations.length === 0) break;

                    const result = await this.detectAndProcessTrips(
                        locations, vehicle.id, macIdGps, currentTrip
                    );

                    totalTripsProcessed += result.tripsCreated;
                    totalTripsMerged    += result.tripsMerged;
                    offset              += this.MAX_LOCATIONS_PER_BATCH;

                    currentTrip = await this.getOngoingTrip(vehicle.id, macIdGps);
                }
            } else {
                const locations = await Location.findAll({
                    where:      { mac_id_gps: macIdGps, processed: false },
                    order:      [["sys_time", "ASC"]],
                    attributes: ["id", "latitude", "longitude", "speed", "sys_time"],
                    raw:        true
                });

                const result = await this.detectAndProcessTrips(
                    locations, vehicle.id, macIdGps, ongoingTrip
                );

                totalTripsProcessed = result.tripsCreated;
                totalTripsMerged    = result.tripsMerged;
            }

            if (totalTripsProcessed > 0) {
                logger.info(`[TRIP DETECTION] Post-processing: checking for trips to merge for vehicle ${vehicle.id}`);
                const additionalMerges = await this.mergeNearbyTrips(vehicle.id, macIdGps);
                totalTripsMerged += additionalMerges;

                logger.info(
                    `[TRIP DETECTION] ${vehicle.immatriculation}: ` +
                    `${totalTripsProcessed} trip(s) processed, ${totalTripsMerged} merged`
                );
            }

            return { skipped: false, tripsCreated: totalTripsProcessed, tripsMerged: totalTripsMerged };

        } catch (error) {
            logger.error(`[TRIP DETECTION] Error processing vehicle ${macIdGps}: ${error.message}`);
            throw error;
        }
    }

    static async checkUserTripTracking(vehicleId) {
        try {
            const association = await AssocUserVoitures.findOne({
                where:      { voiture_id: vehicleId },
                attributes: ["user_id", "voiture_id"],
                raw:        true
            });

            if (!association) {
                return { enabled: true, reason: "No user associated — default enabled" };
            }

            const user = await User.findByPk(association.user_id, {
                attributes: ["id", "trip_tracking_enabled"],
                raw:        true
            });

            if (!user) {
                return { enabled: true, reason: "User not found — default enabled" };
            }

            const isEnabled = user.trip_tracking_enabled !== false;
            if (!isEnabled) {
                return { enabled: false, reason: "Trip tracking disabled by user" };
            }

            return { enabled: true, userId: user.id };

        } catch (error) {
            logger.error(`[TRIP DETECTION] Error checking trip tracking for vehicle ${vehicleId}: ${error.message}`);
            return { enabled: false, reason: "Error checking settings" };
        }
    }

    static async getOngoingTrip(vehicleId, macIdGps) {
        try {
            const ongoingTrip = await Trip.findOne({
                where: {
                    vehicle_id: vehicleId,
                    mac_id_gps: macIdGps,
                    status:     "ongoing"
                },
                attributes: ["id", "vehicle_id", "mac_id_gps", "start_time", "end_time", "status"],
                order:      [["created_at", "DESC"]],
                raw:        true
            });

            if (!ongoingTrip) return null;

            const waypointCount = await TripWaypoint.count({ where: { trip_id: ongoingTrip.id } });
            return { ...ongoingTrip, currentWaypointCount: waypointCount };

        } catch (error) {
            logger.error(`[TRIP DETECTION] Error fetching ongoing trip: ${error.message}`);
            return null;
        }
    }

    // ==================== CORE DETECTION LOOP ====================

    static async detectAndProcessTrips(locations, vehicleId, macIdGps, ongoingTrip) {
        let tripsCreated  = 0;
        let tripsMerged   = 0;
        let currentTrip   = ongoingTrip;
        let lastMovingTime    = null;
        let lastValidPosition = null;
        let newLocationIds    = [];
        let newWaypoints      = [];

        let rejectedOutliers        = 0;
        let rejectedDirectionErrors = 0;

        let consecutiveMovingPoints = [];
        let tripStartBuffer         = [];
        let totalDistanceTraveled   = 0;

        if (currentTrip) {
            lastMovingTime = new Date(currentTrip.end_time);
            logger.debug(`[TRIP DETECTION] Continuing trip ${currentTrip.id} from ${lastMovingTime}`);
        }

        for (let i = 0; i < locations.length; i++) {

            // ✅ NON-BLOCKING FIX: yield to the event loop every YIELD_EVERY
            // iterations so pending HTTP requests can be handled between chunks.
            // This eliminates the "app freezes during trip detection" problem.
            if (i > 0 && i % YIELD_EVERY === 0) {
                await yieldToEventLoop();
            }

            const loc           = locations[i];
            const reportedSpeed = Number(loc.speed || 0);
            const locTime       = new Date(loc.sys_time);

            const timeDiff     = lastValidPosition
                ? (locTime - lastValidPosition.time) / 1000
                : 10;

            const isValidPoint = this.isValidGPSPoint(loc, lastValidPosition, timeDiff);

            if (!isValidPoint) {
                rejectedOutliers++;
                continue;
            }

            if (i < locations.length - 1 && lastValidPosition) {
                if (!this.isConsistentDirection(lastValidPosition, loc, locations[i + 1])) {
                    rejectedDirectionErrors++;
                    continue;
                }
            }

            const calculatedSpeed = this.calculateSpeedFromGPS(lastValidPosition, loc, locTime);
            const actualSpeed     = Math.max(reportedSpeed, calculatedSpeed);
            const isRealMovement  = this.isRealMovement(loc, lastValidPosition, actualSpeed);
            const isMoving        = actualSpeed >= this.MIN_SPEED_THRESHOLD && isRealMovement;

            // ── No active trip ─────────────────────────────────────────────────
            if (!currentTrip) {
                if (isMoving) {
                    consecutiveMovingPoints.push(loc);
                    tripStartBuffer.push(loc);

                    if (tripStartBuffer.length > 1) {
                        const prev = tripStartBuffer[tripStartBuffer.length - 2];
                        totalDistanceTraveled += this.calculateHaversineDistance(
                            prev.latitude, prev.longitude,
                            loc.latitude,  loc.longitude
                        ) * 1000;
                    }

                    const enoughPoints   = consecutiveMovingPoints.length >= this.MIN_CONSECUTIVE_MOVING_POINTS;
                    const enoughDistance = totalDistanceTraveled >= this.MIN_DISTANCE_TO_START_TRIP_METERS;

                    if (enoughPoints && enoughDistance) {
                        if (this.isCircularMovement(tripStartBuffer)) {
                            logger.warn("[TRIP DETECTION] Circular movement (parking lot drift) — NOT starting trip");
                            consecutiveMovingPoints = [];
                            tripStartBuffer         = [];
                            totalDistanceTraveled   = 0;
                            continue;
                        }

                        const startLoc = tripStartBuffer[0];
                        logger.info(
                            `[TRIP DETECTION] Starting new trip after ` +
                            `${consecutiveMovingPoints.length} moving points, ` +
                            `${totalDistanceTraveled.toFixed(0)}m traveled`
                        );

                        currentTrip = await this.createNewTrip(vehicleId, macIdGps, startLoc);

                        if (!currentTrip) {
                            logger.error("[TRIP DETECTION] Failed to create trip — resetting buffers");
                            consecutiveMovingPoints = [];
                            tripStartBuffer         = [];
                            totalDistanceTraveled   = 0;
                            continue;
                        }

                        // ✅ FIX: store raw GPS points — do NOT smooth before saving.
                        // smoothPath() shifts coordinates off their true position which
                        // degrades OSRM road-snapping at display time.
                        newLocationIds = tripStartBuffer.map(l => l.id);
                        newWaypoints   = tripStartBuffer.map((l, idx) =>
                            this.prepareWaypoint(l, idx + 1)
                        );

                        lastMovingTime    = locTime;
                        lastValidPosition = {
                            latitude:  loc.latitude,
                            longitude: loc.longitude,
                            time:      locTime
                        };

                        consecutiveMovingPoints = [];
                        tripStartBuffer         = [];
                        totalDistanceTraveled   = 0;
                    }
                } else {
                    if (consecutiveMovingPoints.length > 0) {
                        logger.debug(
                            `[TRIP DETECTION] Movement interrupted — resetting buffers ` +
                            `(had ${consecutiveMovingPoints.length} points, ${totalDistanceTraveled.toFixed(0)}m)`
                        );
                    }
                    consecutiveMovingPoints = [];
                    tripStartBuffer         = [];
                    totalDistanceTraveled   = 0;
                }
                continue;
            }

            // ── Active trip ────────────────────────────────────────────────────
            newLocationIds.push(loc.id);

            const sequenceOrder = (currentTrip.currentWaypointCount || 0) + newWaypoints.length + 1;
            // ✅ FIX: raw GPS point stored — no smoothPath() applied here
            newWaypoints.push(this.prepareWaypoint(loc, sequenceOrder));

            if (isMoving) {
                lastMovingTime    = locTime;
                lastValidPosition = {
                    latitude:  loc.latitude,
                    longitude: loc.longitude,
                    time:      locTime
                };
                logger.debug(`[TRIP DETECTION] Trip ${currentTrip.id} continues — ${actualSpeed.toFixed(1)} km/h`);
            } else {
                const idleMinutes = (locTime - lastMovingTime) / 60000;
                logger.debug(`[TRIP DETECTION] Trip ${currentTrip.id} idle for ${idleMinutes.toFixed(1)} min`);

                if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                    logger.info(
                        `[TRIP DETECTION] Ending trip ${currentTrip.id} — ` +
                        `idle ${idleMinutes.toFixed(1)} min >= threshold ${this.IDLE_THRESHOLD_MINUTES} min`
                    );

                    const saved = await this.finalizeTrip(currentTrip, loc, newWaypoints, newLocationIds);
                    if (saved) tripsCreated++;

                    currentTrip       = null;
                    lastMovingTime    = null;
                    lastValidPosition = null;
                    newLocationIds    = [];
                    newWaypoints      = [];
                }
            }
        }

        // ── Handle still-active trip at end of batch ───────────────────────────
        if (currentTrip && newWaypoints.length > 0) {
            const lastLoc     = locations[locations.length - 1];
            const lastLocTime = new Date(lastLoc.sys_time);
            const idleMinutes = lastMovingTime
                ? (lastLocTime - lastMovingTime) / 60000
                : this.IDLE_THRESHOLD_MINUTES;

            logger.debug(
                `[TRIP DETECTION] End of batch — trip ${currentTrip.id} ` +
                `idle ${idleMinutes.toFixed(1)} min`
            );

            if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                logger.info(`[TRIP DETECTION] Finalizing trip ${currentTrip.id} at end of batch`);
                const saved = await this.finalizeTrip(currentTrip, lastLoc, newWaypoints, newLocationIds);
                if (saved) tripsCreated++;
            } else {
                logger.debug(`[TRIP DETECTION] Trip ${currentTrip.id} still ongoing — updating`);
                const updated = await this.updateOngoingTrip(currentTrip, lastLoc, newWaypoints, newLocationIds);
                if (updated) tripsCreated++;
            }
        }

        if (rejectedOutliers > 0 || rejectedDirectionErrors > 0) {
            logger.info(
                `[TRIP DETECTION] GPS correction: ` +
                `${rejectedOutliers} outlier(s) rejected, ` +
                `${rejectedDirectionErrors} direction error(s) rejected`
            );
        }

        return { tripsCreated, tripsMerged };
    }

    // ==================== SPEED & MOVEMENT HELPERS ====================

    static calculateSpeedFromGPS(lastPosition, currentLoc, currentTime) {
        if (!lastPosition || !lastPosition.time) return 0;

        const distanceKm    = this.calculateHaversineDistance(
            lastPosition.latitude, lastPosition.longitude,
            currentLoc.latitude,   currentLoc.longitude
        );
        const timeDiffHours = (currentTime - lastPosition.time) / 3_600_000;

        return timeDiffHours === 0 ? 0 : Math.max(0, distanceKm / timeDiffHours);
    }

    static isRealMovement(currentLoc, lastRealPosition, speed) {
        if (!lastRealPosition) return true;

        if (speed < this.MAX_PARKED_SPEED) {
            const distance = this.calculateHaversineDistance(
                lastRealPosition.latitude, lastRealPosition.longitude,
                currentLoc.latitude,       currentLoc.longitude
            ) * 1000;

            if (distance < this.GPS_DRIFT_THRESHOLD_METERS) {
                logger.debug(`[GPS VALIDATE] Drift detected: ${distance.toFixed(1)}m at ${speed.toFixed(1)} km/h`);
                return false;
            }
        }

        return true;
    }

    static isCircularMovement(locations) {
        if (locations.length < 3) return false;

        const first = locations[0];
        const last  = locations[locations.length - 1];

        const netDisplacement = this.calculateHaversineDistance(
            first.latitude, first.longitude,
            last.latitude,  last.longitude
        ) * 1000;

        if (netDisplacement < this.PARKING_LOT_RADIUS_METERS) {
            logger.warn(
                `[TRIP DETECTION] Circular movement: ` +
                `${locations.length} points, ${netDisplacement.toFixed(1)}m net displacement`
            );
            return true;
        }

        return false;
    }

    // ==================== TRIP MERGE ====================

    static async mergeNearbyTrips(vehicleId, macIdGps) {
        try {
            const recentTrips = await Trip.findAll({
                where: { vehicle_id: vehicleId, mac_id_gps: macIdGps, status: "completed" },
                order: [["start_time", "DESC"]],
                limit: 10,
                raw:   true
            });

            if (recentTrips.length < 2) return 0;

            let mergeCount = 0;

            for (let i = 0; i < recentTrips.length - 1; i++) {
                const older  = recentTrips[i + 1];
                const newer  = recentTrips[i];
                const gapMin = (new Date(newer.start_time) - new Date(older.end_time)) / 60000;

                if (gapMin > 0 && gapMin <= this.TRIP_MERGE_THRESHOLD_MINUTES) {
                    logger.info(
                        `[TRIP DETECTION] Merging trips ${older.id} and ${newer.id} ` +
                        `(gap: ${gapMin.toFixed(1)} min)`
                    );
                    const merged = await this.mergeTwoTrips(older, newer);
                    if (merged) {
                        mergeCount++;
                        recentTrips.splice(i, 1);
                        i--;
                    }
                }
            }

            if (mergeCount > 0) logger.info(`[TRIP DETECTION] Merged ${mergeCount} trip pair(s)`);
            return mergeCount;

        } catch (error) {
            logger.error(`[TRIP DETECTION] Error merging trips: ${error.message}`);
            return 0;
        }
    }

    static async mergeTwoTrips(trip1, trip2) {
        const transaction = await sequelize.transaction();

        try {
            const [waypoints1, waypoints2] = await Promise.all([
                TripWaypoint.findAll({
                    where: { trip_id: trip1.id },
                    order: [["sequence_order", "ASC"]],
                    raw:   true,
                    transaction
                }),
                TripWaypoint.findAll({
                    where: { trip_id: trip2.id },
                    order: [["sequence_order", "ASC"]],
                    raw:   true,
                    transaction
                })
            ]);

            const allWaypoints = [...waypoints1, ...waypoints2];
            const metrics      = this.calculateTripMetrics(allWaypoints);

            await Trip.update({
                end_time:           trip2.end_time,
                end_latitude:       trip2.end_latitude,
                end_longitude:      trip2.end_longitude,
                end_address:        trip2.end_address,
                end_address_status: trip2.end_address_status || "geocoded",
                duration_minutes:   Math.round(metrics.durationMinutes),
                total_distance_km:  parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh:      parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh:      Math.max(
                    parseFloat(trip1.max_speed_kmh || 0),
                    parseFloat(trip2.max_speed_kmh || 0)
                ),
                waypoint_count: allWaypoints.length
            }, { where: { id: trip1.id }, transaction });

            const offset = waypoints1.length;
            await TripWaypoint.update(
                {
                    trip_id:        trip1.id,
                    sequence_order: sequelize.literal(`sequence_order + ${offset}`)
                },
                { where: { trip_id: trip2.id }, transaction }
            );

            await Location.update(
                { trip_id: trip1.id },
                { where: { trip_id: trip2.id }, transaction }
            );

            await Trip.destroy({ where: { id: trip2.id }, transaction });
            await transaction.commit();

            logger.info(`[TRIP DETECTION] Merged trip ${trip2.id} into trip ${trip1.id}`);
            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`[TRIP DETECTION] Error merging trips: ${error.message}`);
            return false;
        }
    }

    // ==================== TRIP PERSISTENCE ====================

    static async createNewTrip(vehicleId, macIdGps, startLocation) {
        try {
            logger.info(`[TRIP DETECTION] Geocoding start address for vehicle ${vehicleId}...`);

            const startAddressData = await this.reverseGeocode(
                startLocation.latitude,
                startLocation.longitude
            );

            const trip = await Trip.create({
                vehicle_id:           vehicleId,
                mac_id_gps:           macIdGps,
                start_time:           startLocation.sys_time,
                end_time:             startLocation.sys_time,
                start_latitude:       startLocation.latitude,
                start_longitude:      startLocation.longitude,
                start_address:        startAddressData.address,
                start_address_status: startAddressData.status,
                end_latitude:         startLocation.latitude,
                end_longitude:        startLocation.longitude,
                end_address:          startAddressData.address,
                end_address_status:   startAddressData.status,
                status:               "ongoing",
                duration_minutes:     0,
                total_distance_km:    0,
                avg_speed_kmh:        0,
                max_speed_kmh:        0,
                waypoint_count:       0
            });

            logger.info(`[TRIP DETECTION] Created trip ${trip.id} — start: "${startAddressData.address}"`);

            return {
                id:                   trip.id,
                vehicle_id:           vehicleId,
                mac_id_gps:           macIdGps,
                start_time:           startLocation.sys_time,
                end_time:             startLocation.sys_time,
                status:               "ongoing",
                currentWaypointCount: 0
            };

        } catch (error) {
            logger.error(`[TRIP DETECTION] Error creating trip: ${error.message}`);
            return null;
        }
    }

    static async updateOngoingTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            if (newWaypoints.length > 0) {
                // ✅ FIX: store raw GPS points — smoothPath() removed from here.
                // Raw coordinates give OSRM the best chance to snap to roads correctly.
                const waypointsToInsert = newWaypoints.map(w => ({ ...w, trip_id: currentTrip.id }));

                for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                    await TripWaypoint.bulkCreate(
                        waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE),
                        { transaction }
                    );
                }

                logger.debug(
                    `[TRIP DETECTION] Added ${newWaypoints.length} raw waypoints to trip ${currentTrip.id}`
                );
            }

            const allWaypoints = await TripWaypoint.findAll({
                where:      { trip_id: currentTrip.id },
                attributes: ["latitude", "longitude", "speed", "recorded_at"],
                order:      [["sequence_order", "ASC"]],
                raw:        true,
                transaction
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            await Trip.update({
                end_time:          endLocation.sys_time,
                end_latitude:      endLocation.latitude,
                end_longitude:     endLocation.longitude,
                duration_minutes:  Math.round(metrics.durationMinutes),
                total_distance_km: parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh:     parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh:     parseFloat(metrics.maxSpeed.toFixed(2)),
                waypoint_count:    allWaypoints.length
            }, { where: { id: currentTrip.id }, transaction });

            if (locationIds.length > 0) {
                await Location.update(
                    { processed: true, trip_id: currentTrip.id },
                    { where: { id: locationIds }, transaction }
                );
            }

            await transaction.commit();

            logger.info(
                `[TRIP DETECTION] Updated ongoing trip ${currentTrip.id} — ` +
                `${allWaypoints.length} waypoints, ` +
                `${Math.round(metrics.durationMinutes)} min, ` +
                `${metrics.totalDistanceKm.toFixed(2)} km`
            );

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`[TRIP DETECTION] Error updating ongoing trip ${currentTrip.id}: ${error.message}`);
            return false;
        }
    }

    static async finalizeTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            if (newWaypoints.length > 0) {
                // ✅ Store RAW GPS points.
                // Do NOT simplify here. Simplification was reducing trips to 2–3 points.
                const waypointsToInsert = newWaypoints.map(w => ({
                    ...w,
                    trip_id: currentTrip.id
                }));

                for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                    await TripWaypoint.bulkCreate(
                        waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE),
                        { transaction }
                    );
                }
            }

            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                attributes: ["latitude", "longitude", "speed", "recorded_at"],
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction
            });

            logger.info(
                `[TRIP DETECTION] Trip ${currentTrip.id}: ` +
                `${allWaypoints.length} raw waypoints saved`
            );

            const metrics = this.calculateTripMetrics(allWaypoints);

            if (
                metrics.durationMinutes < this.MIN_TRIP_DURATION_MIN ||
                metrics.totalDistanceKm < this.MIN_TRIP_DISTANCE_KM
            ) {
                logger.warn(
                    `[TRIP DETECTION] Trip ${currentTrip.id} below minimums — deleting ` +
                    `(${metrics.durationMinutes.toFixed(1)} min, ${metrics.totalDistanceKm.toFixed(2)} km)`
                );

                await TripWaypoint.destroy({
                    where: { trip_id: currentTrip.id },
                    transaction
                });

                await Location.update(
                    { trip_id: null },
                    { where: { trip_id: currentTrip.id }, transaction }
                );

                await Trip.destroy({
                    where: { id: currentTrip.id },
                    transaction
                });

                await Location.update(
                    { processed: true, trip_id: null },
                    { where: { id: locationIds }, transaction }
                );

                await transaction.commit();
                return false;
            }

            logger.info(`[TRIP DETECTION] Geocoding end address for trip ${currentTrip.id}...`);

            const endAddressData = await this.reverseGeocode(
                endLocation.latitude,
                endLocation.longitude
            );

            await Trip.update({
                end_time: endLocation.sys_time,
                end_latitude: endLocation.latitude,
                end_longitude: endLocation.longitude,
                end_address: endAddressData.address,
                end_address_status: endAddressData.status,
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh: parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh: parseFloat(metrics.maxSpeed.toFixed(2)),
                waypoint_count: allWaypoints.length,
                status: "completed"
            }, {
                where: { id: currentTrip.id },
                transaction
            });

            await Location.update(
                { processed: true, trip_id: currentTrip.id },
                { where: { id: locationIds }, transaction }
            );

            await transaction.commit();

            logger.info(
                `[TRIP DETECTION] ✅ Trip ${currentTrip.id} finalized — ` +
                `end: "${endAddressData.address}" | ` +
                `${Math.round(metrics.durationMinutes)} min | ` +
                `${metrics.totalDistanceKm.toFixed(2)} km | ` +
                `${metrics.avgSpeed.toFixed(1)} km/h avg | ` +
                `${allWaypoints.length} raw waypoints`
            );

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`[TRIP DETECTION] Error finalizing trip ${currentTrip.id}: ${error.message}`);
            return false;
        }
    }

    // ==================== METRICS & MATH ====================

    static prepareWaypoint(location, sequenceOrder) {
        return {
            latitude:       location.latitude,
            longitude:      location.longitude,
            speed:          location.speed || 0,
            recorded_at:    location.sys_time,
            sequence_order: sequenceOrder
        };
    }

    static calculateTripMetrics(waypoints) {
        if (!waypoints || waypoints.length === 0) {
            return { totalDistanceKm: 0, durationMinutes: 0, avgSpeed: 0, maxSpeed: 0 };
        }

        let totalDistance = 0;
        let maxSpeed      = 0;
        let sumSpeed      = 0;
        let speedCount    = 0;

        for (let i = 1; i < waypoints.length; i++) {
            const prev = waypoints[i - 1];
            const curr = waypoints[i];

            totalDistance += this.calculateHaversineDistance(
                Number(prev.latitude), Number(prev.longitude),
                Number(curr.latitude), Number(curr.longitude)
            );

            const speed = Number(curr.speed || 0);
            if (speed > maxSpeed) maxSpeed = speed;
            if (speed > 0) { sumSpeed += speed; speedCount++; }
        }

        const startTime       = new Date(waypoints[0].recorded_at);
        const endTime         = new Date(waypoints[waypoints.length - 1].recorded_at);
        const durationMinutes = Math.max(0, (endTime - startTime) / 60000);

        return {
            totalDistanceKm: totalDistance,
            durationMinutes,
            avgSpeed: speedCount > 0 ? sumSpeed / speedCount : 0,
            maxSpeed
        };
    }

    static calculateHaversineDistance(lat1, lon1, lat2, lon2) {
        const R    = 6371;
        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);

        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRadians(lat1)) *
            Math.cos(this.toRadians(lat2)) *
            Math.sin(dLon / 2) ** 2;

        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    static toRadians(degrees) { return degrees * Math.PI / 180; }
    static toDegrees(radians) { return radians * 180 / Math.PI; }
}

module.exports = TripDetectionService;