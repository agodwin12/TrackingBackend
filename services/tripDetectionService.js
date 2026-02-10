// services/tripDetectionService.js - FIXED GPS THRESHOLDS FOR COMPLETE ROUTES
const { Op } = require("sequelize");
const Location = require("../models/location");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const sequelize = require("../config/database");
const logger = require("../utils/logger");
const axios = require('axios');

class TripDetectionService {
    // ==================== FIXED CONFIGURATION ====================

    // 🚗 TRIP DETECTION THRESHOLDS
    static IDLE_THRESHOLD_MINUTES = Number(process.env.TRIP_IDLE_MINUTES ?? 10);
    static MIN_SPEED_THRESHOLD = Number(process.env.TRIP_MIN_SPEED_KMH ?? 10);
    static TRIP_MERGE_THRESHOLD_MINUTES = Number(process.env.TRIP_MERGE_MINUTES ?? 3);

    // 🎯 MINIMUM TRIP REQUIREMENTS - ✅ REDUCED
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION ?? 2); // ✅ REDUCED from 5 to 2
    static MIN_TRIP_DISTANCE_KM = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 0.5); // ✅ REDUCED from 1.5 to 0.5

    // 📍 GPS DRIFT DETECTION
    static GPS_DRIFT_THRESHOLD_METERS = Number(process.env.GPS_DRIFT_METERS ?? 100);
    static MAX_PARKED_SPEED = 3;

    // 🆕 TRIP START CONFIRMATION - ✅ RELAXED
    static MIN_CONSECUTIVE_MOVING_POINTS = 3; // ✅ REDUCED from 5 to 3
    static MIN_DISTANCE_TO_START_TRIP_METERS = 100; // ✅ REDUCED from 200 to 100
    static PARKING_LOT_RADIUS_METERS = 100;

    // 🆕 GPS POSITION CORRECTION THRESHOLDS - ✅ RELAXED
    static MAX_SPEED_KMPH = 200; // ✅ Increased from 180
    static MAX_JUMP_DISTANCE_METERS = 1000; // ✅ DOUBLED from 500
    static MIN_JUMP_TIME_SECONDS = 2; // ✅ REDUCED from 3
    static DIRECTION_CHANGE_THRESHOLD = 170; // ✅ RELAXED from 135 to 170 (allows sharper turns)
    static DOUGLAS_PEUCKER_TOLERANCE = 0.0001; // ✅ REDUCED from 0.00005 (less aggressive simplification)

    // ⚡ PERFORMANCE SETTINGS
    static MAX_LOCATIONS_PER_BATCH = 10000;
    static WAYPOINT_BATCH_SIZE = 50000;

    // 🗺️ GEOCODING
    static GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyBn88TP5X-xaRCYo5gYxvGnVy_0WYotZWo';

    // ==================== IMMEDIATE GEOCODING ====================

    /**
     * ✅ IMPROVED reverse geocoding with detailed error logging
     */
    static async reverseGeocode(latitude, longitude) {
        try {
            logger.info(`📍 Geocoding coordinates: [${latitude}, ${longitude}]`);

            const url = 'https://maps.googleapis.com/maps/api/geocode/json';
            const params = {
                latlng: `${latitude},${longitude}`,
                key: this.GOOGLE_MAPS_API_KEY,
                language: 'en'
            };

            logger.debug(`🌐 Google Maps API URL: ${url}`);
            logger.debug(`🌐 Request params:`, params);

            const response = await axios.get(url, {
                params: params,
                timeout: 10000
            });

            logger.debug(`📥 API Response Status: ${response.data.status}`);
            logger.debug(`📥 API Response:`, JSON.stringify(response.data, null, 2));

            if (response.data.status === 'ZERO_RESULTS') {
                logger.warn(`⚠️ Geocoding: No results found for [${latitude}, ${longitude}]`);
                return {
                    address: 'Unknown Location',
                    status: 'failed',
                    success: false
                };
            }

            if (response.data.status === 'OVER_QUERY_LIMIT') {
                logger.error(`❌ Geocoding: API quota exceeded or rate limit reached`);
                return {
                    address: 'Location unavailable (rate limit)',
                    status: 'failed',
                    success: false
                };
            }

            if (response.data.status === 'REQUEST_DENIED') {
                logger.error(`❌ Geocoding: API request denied - check API key and restrictions`);
                logger.error(`❌ Error message: ${response.data.error_message || 'No error message'}`);
                return {
                    address: 'Location unavailable (API error)',
                    status: 'failed',
                    success: false
                };
            }

            if (response.data.status === 'INVALID_REQUEST') {
                logger.error(`❌ Geocoding: Invalid request - check coordinates format`);
                return {
                    address: 'Location unavailable (invalid request)',
                    status: 'failed',
                    success: false
                };
            }

            if (response.data.status === 'UNKNOWN_ERROR') {
                logger.error(`❌ Geocoding: Server error - will retry later`);
                return {
                    address: 'Location unavailable (server error)',
                    status: 'failed',
                    success: false
                };
            }

            if (response.data.status === 'OK' && response.data.results && response.data.results.length > 0) {
                const result = response.data.results[0];

                logger.debug(`✅ Found ${response.data.results.length} result(s)`);
                logger.debug(`✅ First result formatted_address: ${result.formatted_address}`);

                let neighborhood = null;
                let locality = null;
                let sublocality = null;
                let route = null;
                let administrativeArea = null;

                for (const component of result.address_components) {
                    if (component.types.includes('neighborhood')) {
                        neighborhood = component.long_name;
                    } else if (component.types.includes('route')) {
                        route = component.long_name;
                    } else if (component.types.includes('sublocality') || component.types.includes('sublocality_level_1')) {
                        sublocality = component.long_name;
                    } else if (component.types.includes('locality')) {
                        locality = component.long_name;
                    } else if (component.types.includes('administrative_area_level_2')) {
                        if (!locality) administrativeArea = component.long_name;
                    } else if (component.types.includes('administrative_area_level_1')) {
                        if (!locality && !administrativeArea) administrativeArea = component.long_name;
                    }
                }

                logger.debug(`📍 Extracted components:`, {
                    route,
                    sublocality,
                    neighborhood,
                    locality,
                    administrativeArea
                });

                let address;
                if (route && locality) {
                    address = `${route}, ${locality}`;
                } else if (route && sublocality) {
                    address = `${route}, ${sublocality}`;
                } else if (route) {
                    address = route;
                } else if (sublocality) {
                    address = sublocality;
                } else if (neighborhood) {
                    address = neighborhood;
                } else if (locality) {
                    address = locality;
                } else if (administrativeArea) {
                    address = administrativeArea;
                } else {
                    address = result.formatted_address.split(',')[0];
                }

                logger.info(`✅ Geocoded successfully: "${address}"`);
                return {
                    address: address || 'Unknown Location',
                    status: 'geocoded',
                    success: true
                };
            } else {
                logger.warn(`⚠️ Geocoding failed with status: ${response.data.status}`);
                return {
                    address: 'Location unavailable',
                    status: 'failed',
                    success: false
                };
            }
        } catch (error) {
            logger.error(`❌ Geocoding exception for [${latitude}, ${longitude}]:`, error.message);

            if (error.code === 'ECONNABORTED') {
                logger.error(`❌ Request timeout - Google Maps API took too long to respond`);
            } else if (error.code === 'ENOTFOUND') {
                logger.error(`❌ DNS error - Cannot reach maps.googleapis.com`);
            } else if (error.code === 'ECONNREFUSED') {
                logger.error(`❌ Connection refused - Check network/firewall`);
            } else if (error.response) {
                logger.error(`❌ API returned error status: ${error.response.status}`);
                logger.error(`❌ API response data:`, error.response.data);
            } else if (error.request) {
                logger.error(`❌ No response received from API`);
                logger.error(`❌ Request details:`, error.request);
            }

            logger.error(`❌ Full error stack:`, error.stack);

            return {
                address: 'Location unavailable',
                status: 'failed',
                success: false
            };
        }
    }

    // ==================== MAIN ENTRY POINT ====================
    static async detectAndCreateTrips() {
        logger.info("=== 🚀 ENHANCED TRIP DETECTION WITH GPS CORRECTION START ===");

        try {
            const macs = await this.getVehiclesWithUnprocessedData();

            if (macs.length === 0) {
                logger.debug("✅ No vehicles with unprocessed data");
                return { success: true, tripsCreated: 0, vehiclesProcessed: 0 };
            }

            logger.info(`📍 Found ${macs.length} vehicles with unprocessed data`);

            let totalTrips = 0;
            let mergedTrips = 0;
            let skipped = 0;
            let errors = 0;

            for (const mac of macs) {
                try {
                    const res = await this.processVehicleLocations(mac);
                    if (res.skipped) skipped++;
                    totalTrips += res.tripsCreated;
                    mergedTrips += res.tripsMerged || 0;
                } catch (error) {
                    logger.error(`🔥 Error processing vehicle ${mac}:`, error);
                    errors++;
                }
            }

            logger.info("=== ✅ ENHANCED TRIP DETECTION COMPLETE ===", {
                tripsCreated: totalTrips,
                tripsMerged: mergedTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped: skipped,
                errors
            });

            return {
                success: true,
                tripsCreated: totalTrips,
                tripsMerged: mergedTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped: skipped,
                errors
            };

        } catch (error) {
            logger.error("🔥 Fatal error in trip detection:", error);
            return { success: false, error: error.message };
        }
    }

    static async getVehiclesWithUnprocessedData() {
        try {
            const rows = await Location.findAll({
                where: { processed: false },
                attributes: [
                    [sequelize.fn("DISTINCT", sequelize.col("mac_id_gps")), "mac_id_gps"],
                ],
                raw: true,
            });
            return rows.map(r => r.mac_id_gps);
        } catch (error) {
            logger.error("🔥 Error fetching vehicles with unprocessed data:", error);
            return [];
        }
    }

    // ==================== GPS POSITION CORRECTION ALGORITHMS ====================

    static isValidGPSPoint(currentLoc, lastValidLoc, timeDiff) {
        if (!lastValidLoc) return true;

        const distance = this.calculateHaversineDistance(
            lastValidLoc.latitude,
            lastValidLoc.longitude,
            currentLoc.latitude,
            currentLoc.longitude
        ) * 1000;

        if (timeDiff > this.MIN_JUMP_TIME_SECONDS) {
            const speed = (distance / 1000) / (timeDiff / 3600);
            if (speed > this.MAX_SPEED_KMPH) {
                logger.warn(`⚠️ GPS outlier rejected: ${speed.toFixed(1)} km/h (max: ${this.MAX_SPEED_KMPH})`);
                return false;
            }
        }

        if (distance > this.MAX_JUMP_DISTANCE_METERS && timeDiff < 10) {
            logger.warn(`⚠️ GPS outlier rejected: ${distance.toFixed(0)}m jump in ${timeDiff.toFixed(1)}s`);
            return false;
        }

        return true;
    }

    static isConsistentDirection(prevLoc, currentLoc, nextLoc) {
        if (!prevLoc || !nextLoc) return true;

        const bearing1 = this.calculateBearing(
            prevLoc.latitude,
            prevLoc.longitude,
            currentLoc.latitude,
            currentLoc.longitude
        );

        const bearing2 = this.calculateBearing(
            currentLoc.latitude,
            currentLoc.longitude,
            nextLoc.latitude,
            nextLoc.longitude
        );

        let angleDiff = Math.abs(bearing2 - bearing1);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;

        if (angleDiff > this.DIRECTION_CHANGE_THRESHOLD) {
            const distance = this.calculateHaversineDistance(
                prevLoc.latitude,
                prevLoc.longitude,
                nextLoc.latitude,
                nextLoc.longitude
            ) * 1000;

            if (distance > 50) {
                logger.warn(`⚠️ Inconsistent direction: ${angleDiff.toFixed(0)}° change`);
                return false;
            }
        }

        return true;
    }

    static calculateBearing(lat1, lon1, lat2, lon2) {
        const dLon = this.toRadians(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(this.toRadians(lat2));
        const x = Math.cos(this.toRadians(lat1)) * Math.sin(this.toRadians(lat2)) -
            Math.sin(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.cos(dLon);
        const bearing = this.toDegrees(Math.atan2(y, x));
        return (bearing + 360) % 360;
    }

    static simplifyPath(points, tolerance = this.DOUGLAS_PEUCKER_TOLERANCE) {
        if (points.length <= 2) return points;

        const pointToSegmentDistance = (point, start, end) => {
            const x = point.longitude;
            const y = point.latitude;
            const x1 = start.longitude;
            const y1 = start.latitude;
            const x2 = end.longitude;
            const y2 = end.latitude;

            const A = x - x1;
            const B = y - y1;
            const C = x2 - x1;
            const D = y2 - y1;

            const dot = A * C + B * D;
            const lenSq = C * C + D * D;
            let param = -1;

            if (lenSq !== 0) param = dot / lenSq;

            let xx, yy;

            if (param < 0) {
                xx = x1;
                yy = y1;
            } else if (param > 1) {
                xx = x2;
                yy = y2;
            } else {
                xx = x1 + param * C;
                yy = y1 + param * D;
            }

            const dx = x - xx;
            const dy = y - yy;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const douglasPeucker = (pts, epsilon) => {
            if (pts.length <= 2) return pts;

            let maxDistance = 0;
            let index = 0;

            for (let i = 1; i < pts.length - 1; i++) {
                const distance = pointToSegmentDistance(pts[i], pts[0], pts[pts.length - 1]);
                if (distance > maxDistance) {
                    maxDistance = distance;
                    index = i;
                }
            }

            if (maxDistance > epsilon) {
                const left = douglasPeucker(pts.slice(0, index + 1), epsilon);
                const right = douglasPeucker(pts.slice(index), epsilon);
                return left.slice(0, -1).concat(right);
            } else {
                return [pts[0], pts[pts.length - 1]];
            }
        };

        return douglasPeucker(points, tolerance);
    }

    static smoothPath(waypoints, windowSize = 3) {
        if (waypoints.length < windowSize) return waypoints;

        const smoothed = [];
        smoothed.push(waypoints[0]);

        for (let i = 1; i < waypoints.length - 1; i++) {
            const start = Math.max(0, i - Math.floor(windowSize / 2));
            const end = Math.min(waypoints.length, i + Math.floor(windowSize / 2) + 1);
            const window = waypoints.slice(start, end);

            const avgLat = window.reduce((sum, w) => sum + parseFloat(w.latitude), 0) / window.length;
            const avgLng = window.reduce((sum, w) => sum + parseFloat(w.longitude), 0) / window.length;
            const avgSpeed = window.reduce((sum, w) => sum + parseFloat(w.speed || 0), 0) / window.length;

            smoothed.push({
                ...waypoints[i],
                latitude: avgLat,
                longitude: avgLng,
                speed: avgSpeed
            });
        }

        smoothed.push(waypoints[waypoints.length - 1]);

        return smoothed;
    }

    // ==================== VEHICLE PROCESSING ====================
    static async processVehicleLocations(macIdGps) {
        logger.debug(`🔍 Processing vehicle: ${macIdGps}`);

        try {
            const locationCount = await Location.count({
                where: { mac_id_gps: macIdGps, processed: false }
            });

            if (locationCount === 0) {
                logger.debug(`✅ No unprocessed locations for ${macIdGps}`);
                return { skipped: false, tripsCreated: 0, tripsMerged: 0 };
            }

            logger.info(`🔍 Found ${locationCount} unprocessed locations for ${macIdGps}`);

            const vehicle = await Voiture.findOne({
                where: { mac_id_gps: macIdGps },
                attributes: ["id", "immatriculation"],
                raw: true
            });

            if (!vehicle) {
                logger.warn(`⚠️ Vehicle not found for MAC: ${macIdGps} - marking locations as processed`);
                await Location.update(
                    { processed: true },
                    { where: { mac_id_gps: macIdGps, processed: false } }
                );
                return { skipped: false, tripsCreated: 0, tripsMerged: 0 };
            }

            logger.debug(`🔍 Vehicle found: ${vehicle.immatriculation} (ID: ${vehicle.id})`);

            const userCheck = await this.checkUserTripTracking(vehicle.id);

            if (!userCheck.enabled) {
                logger.debug(`🔍 Trip tracking disabled for vehicle ${vehicle.id} - ${userCheck.reason}`);
                await Location.update(
                    { processed: true },
                    { where: { mac_id_gps: macIdGps, processed: false } }
                );
                return { skipped: true, tripsCreated: 0, tripsMerged: 0 };
            }

            logger.debug(`✅ Trip tracking enabled for vehicle ${vehicle.id} - processing trips`);

            const ongoingTrip = await this.getOngoingTrip(vehicle.id, macIdGps);

            let totalTripsProcessed = 0;
            let totalTripsMerged = 0;

            if (locationCount > this.MAX_LOCATIONS_PER_BATCH) {
                logger.info(`📊 Large location set (${locationCount}), using batch processing`);

                let offset = 0;
                let currentTrip = ongoingTrip;

                while (offset < locationCount) {
                    const locations = await Location.findAll({
                        where: { mac_id_gps: macIdGps, processed: false },
                        order: [["sys_time", "ASC"]],
                        limit: this.MAX_LOCATIONS_PER_BATCH,
                        offset: offset,
                        raw: true
                    });

                    if (locations.length === 0) break;

                    const result = await this.detectAndProcessTrips(
                        locations,
                        vehicle.id,
                        macIdGps,
                        currentTrip
                    );

                    totalTripsProcessed += result.tripsCreated;
                    totalTripsMerged += result.tripsMerged;
                    offset += this.MAX_LOCATIONS_PER_BATCH;

                    currentTrip = await this.getOngoingTrip(vehicle.id, macIdGps);
                }
            } else {
                const locations = await Location.findAll({
                    where: { mac_id_gps: macIdGps, processed: false },
                    order: [["sys_time", "ASC"]],
                    attributes: ['id', 'latitude', 'longitude', 'speed', 'sys_time'],
                    raw: true
                });

                const result = await this.detectAndProcessTrips(
                    locations,
                    vehicle.id,
                    macIdGps,
                    ongoingTrip
                );

                totalTripsProcessed = result.tripsCreated;
                totalTripsMerged = result.tripsMerged;
            }

            if (totalTripsProcessed > 0) {
                logger.info(`🔄 Post-processing: Checking for trips to merge...`);
                const additionalMerges = await this.mergeNearbyTrips(vehicle.id, macIdGps);
                totalTripsMerged += additionalMerges;
            }

            if (totalTripsProcessed > 0) {
                logger.info(`✅ Processed ${totalTripsProcessed} trips (${totalTripsMerged} merged) for vehicle ${vehicle.immatriculation}`);
            }

            return {
                skipped: false,
                tripsCreated: totalTripsProcessed,
                tripsMerged: totalTripsMerged
            };

        } catch (error) {
            logger.error(`🔥 Error processing vehicle locations for ${macIdGps}:`, error);
            throw error;
        }
    }

    static async checkUserTripTracking(vehicleId) {
        try {
            const association = await AssocUserVoitures.findOne({
                where: { voiture_id: vehicleId },
                attributes: ['user_id', 'voiture_id'],
                raw: true
            });

            if (!association) {
                logger.debug(`⚠️ No user association found for vehicle ${vehicleId}`);
                return { enabled: true, reason: "No user associated - default enabled" };
            }

            const user = await User.findByPk(association.user_id, {
                attributes: ['id', 'trip_tracking_enabled'],
                raw: true
            });

            if (!user) {
                logger.debug(`⚠️ User not found for association (vehicle ${vehicleId})`);
                return { enabled: true, reason: "User not found - default enabled" };
            }

            const isEnabled = user.trip_tracking_enabled !== false;

            if (!isEnabled) {
                logger.debug(`🔍 Trip tracking disabled by user ${user.id} for vehicle ${vehicleId}`);
                return { enabled: false, reason: "Trip tracking disabled by user" };
            }

            logger.debug(`✅ Trip tracking enabled for vehicle ${vehicleId}`);
            return { enabled: true, userId: user.id };

        } catch (error) {
            logger.error(`🔥 Error checking user trip tracking for vehicle ${vehicleId}:`, error);
            return { enabled: false, reason: "Error checking settings" };
        }
    }

    static async getOngoingTrip(vehicleId, macIdGps) {
        try {
            const ongoingTrip = await Trip.findOne({
                where: {
                    vehicle_id: vehicleId,
                    mac_id_gps: macIdGps,
                    status: 'ongoing'
                },
                attributes: ['id', 'vehicle_id', 'mac_id_gps', 'start_time', 'end_time', 'status'],
                order: [["created_at", "DESC"]],
                raw: true
            });

            if (ongoingTrip) {
                logger.debug(`🔍 Found ongoing trip ${ongoingTrip.id} started at ${ongoingTrip.start_time}`);

                const waypointCount = await TripWaypoint.count({
                    where: { trip_id: ongoingTrip.id }
                });

                return {
                    ...ongoingTrip,
                    currentWaypointCount: waypointCount
                };
            }

            logger.debug("✅ No ongoing trip found");
            return null;

        } catch (error) {
            logger.error("🔥 Error fetching ongoing trip:", error);
            return null;
        }
    }

    // ==================== ENHANCED TRIP DETECTION LOGIC ====================
    static async detectAndProcessTrips(locations, vehicleId, macIdGps, ongoingTrip) {
        let tripsCreated = 0;
        let tripsMerged = 0;
        let currentTrip = ongoingTrip;
        let lastMovingTime = null;
        let lastValidPosition = null;
        let newLocationIds = [];
        let newWaypoints = [];

        let rejectedOutliers = 0;
        let rejectedDirectionErrors = 0;

        let consecutiveMovingPoints = [];
        let tripStartBuffer = [];
        let totalDistanceTraveled = 0;

        if (currentTrip) {
            lastMovingTime = new Date(currentTrip.end_time);
            logger.debug(`🔄 Continuing trip ${currentTrip.id} from ${lastMovingTime}`);
        }

        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];
            const reportedSpeed = Number(loc.speed || 0);
            const locTime = new Date(loc.sys_time);

            const timeDiff = lastValidPosition ? (locTime - lastValidPosition.time) / 1000 : 10;
            const isValidPoint = this.isValidGPSPoint(loc, lastValidPosition, timeDiff);

            if (!isValidPoint) {
                rejectedOutliers++;
                logger.debug(`❌ Rejected GPS outlier at point ${i + 1}`);
                continue;
            }

            if (i < locations.length - 1 && lastValidPosition) {
                const nextLoc = locations[i + 1];
                const isConsistent = this.isConsistentDirection(lastValidPosition, loc, nextLoc);
                if (!isConsistent) {
                    rejectedDirectionErrors++;
                    logger.debug(`❌ Rejected direction inconsistency at point ${i + 1}`);
                    continue;
                }
            }

            const calculatedSpeed = this.calculateSpeedFromGPS(lastValidPosition, loc, locTime);
            const actualSpeed = Math.max(reportedSpeed, calculatedSpeed);

            const isRealMovement = this.isRealMovement(loc, lastValidPosition, actualSpeed);
            const isMoving = actualSpeed >= this.MIN_SPEED_THRESHOLD && isRealMovement;

            logger.debug(`📍 Location ${i + 1}/${locations.length}: reported=${reportedSpeed.toFixed(1)} km/h, calculated=${calculatedSpeed.toFixed(1)} km/h, moving=${isMoving}`);

            if (!currentTrip) {
                if (isMoving) {
                    consecutiveMovingPoints.push(loc);
                    tripStartBuffer.push(loc);

                    if (tripStartBuffer.length > 1) {
                        const lastBufferLoc = tripStartBuffer[tripStartBuffer.length - 2];
                        const dist = this.calculateHaversineDistance(
                            lastBufferLoc.latitude,
                            lastBufferLoc.longitude,
                            loc.latitude,
                            loc.longitude
                        ) * 1000;
                        totalDistanceTraveled += dist;
                    }

                    if (consecutiveMovingPoints.length >= this.MIN_CONSECUTIVE_MOVING_POINTS &&
                        totalDistanceTraveled >= this.MIN_DISTANCE_TO_START_TRIP_METERS) {

                        const isCircularMovement = this.isCircularMovement(tripStartBuffer);

                        if (isCircularMovement) {
                            logger.warn(`⚠️ Circular movement detected (parking lot drift) - NOT starting trip`);
                            consecutiveMovingPoints = [];
                            tripStartBuffer = [];
                            totalDistanceTraveled = 0;
                            continue;
                        }

                        const startLoc = tripStartBuffer[0];
                        logger.info(`🚗 Starting new trip after ${consecutiveMovingPoints.length} consecutive moving points, ${totalDistanceTraveled.toFixed(0)}m traveled`);

                        currentTrip = await this.createNewTrip(vehicleId, macIdGps, startLoc);

                        if (!currentTrip) {
                            logger.error("🔥 Failed to create new trip - resetting buffers");
                            consecutiveMovingPoints = [];
                            tripStartBuffer = [];
                            totalDistanceTraveled = 0;
                            continue;
                        }

                        newLocationIds = tripStartBuffer.map(l => l.id);
                        newWaypoints = tripStartBuffer.map((l, idx) => this.prepareWaypoint(l, idx + 1));

                        lastMovingTime = locTime;
                        lastValidPosition = {
                            latitude: loc.latitude,
                            longitude: loc.longitude,
                            time: locTime
                        };

                        consecutiveMovingPoints = [];
                        tripStartBuffer = [];
                        totalDistanceTraveled = 0;
                    }
                } else {
                    if (consecutiveMovingPoints.length > 0) {
                        logger.debug(`⚠️ Movement interrupted - resetting trip start buffers (had ${consecutiveMovingPoints.length} points, ${totalDistanceTraveled.toFixed(0)}m)`);
                    }
                    consecutiveMovingPoints = [];
                    tripStartBuffer = [];
                    totalDistanceTraveled = 0;
                }
                continue;
            }

            if (currentTrip) {
                newLocationIds.push(loc.id);

                const sequenceOrder = currentTrip.currentWaypointCount
                    ? currentTrip.currentWaypointCount + newWaypoints.length + 1
                    : newWaypoints.length + 1;

                newWaypoints.push(this.prepareWaypoint(loc, sequenceOrder));

                if (isMoving) {
                    lastMovingTime = locTime;
                    lastValidPosition = {
                        latitude: loc.latitude,
                        longitude: loc.longitude,
                        time: locTime
                    };
                    logger.debug(`✅ Trip ${currentTrip.id} continues (speed: ${actualSpeed.toFixed(1)} km/h)`);
                } else {
                    const idleMinutes = (locTime - lastMovingTime) / 60000;

                    logger.debug(`⏸️ Vehicle idle for ${idleMinutes.toFixed(1)} min (threshold: ${this.IDLE_THRESHOLD_MINUTES} min)`);

                    if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                        logger.info(`🛑 Ending trip ${currentTrip.id} after ${idleMinutes.toFixed(1)} min idle`);

                        const saved = await this.finalizeTrip(
                            currentTrip,
                            loc,
                            newWaypoints,
                            newLocationIds
                        );

                        if (saved) tripsCreated++;

                        currentTrip = null;
                        lastMovingTime = null;
                        lastValidPosition = null;
                        newLocationIds = [];
                        newWaypoints = [];
                    }
                }
            }
        }

        if (currentTrip && newWaypoints.length > 0) {
            const lastLoc = locations[locations.length - 1];
            const lastLocTime = new Date(lastLoc.sys_time);
            const idleMinutes = (lastLocTime - lastMovingTime) / 60000;

            if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                logger.debug(`🏁 Finalizing trip ${currentTrip.id} - idle for ${idleMinutes.toFixed(1)} min`);
                const saved = await this.finalizeTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                if (saved) tripsCreated++;
            } else {
                logger.debug(`🔄 Trip ${currentTrip.id} still ongoing - updating (idle: ${idleMinutes.toFixed(1)} min)`);
                const updated = await this.updateOngoingTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                if (updated) tripsCreated++;
            }
        }

        if (rejectedOutliers > 0 || rejectedDirectionErrors > 0) {
            logger.info(`🧹 GPS Correction: Rejected ${rejectedOutliers} outliers, ${rejectedDirectionErrors} direction errors`);
        }

        return { tripsCreated, tripsMerged };
    }

    static calculateSpeedFromGPS(lastPosition, currentLoc, currentTime) {
        if (!lastPosition || !lastPosition.time) return 0;

        const distanceKm = this.calculateHaversineDistance(
            lastPosition.latitude,
            lastPosition.longitude,
            currentLoc.latitude,
            currentLoc.longitude
        );

        const timeDiffHours = (currentTime - lastPosition.time) / (1000 * 60 * 60);

        if (timeDiffHours === 0) return 0;

        const speed = distanceKm / timeDiffHours;
        return Math.max(0, speed);
    }

    static isRealMovement(currentLoc, lastRealPosition, speed) {
        if (!lastRealPosition) return true;

        if (speed < this.MAX_PARKED_SPEED) {
            const distance = this.calculateHaversineDistance(
                lastRealPosition.latitude,
                lastRealPosition.longitude,
                currentLoc.latitude,
                currentLoc.longitude
            ) * 1000;

            if (distance < this.GPS_DRIFT_THRESHOLD_METERS) {
                logger.debug(`📍 GPS drift detected: ${distance.toFixed(1)}m movement at ${speed.toFixed(1)} km/h`);
                return false;
            }
        }

        return true;
    }

    static isCircularMovement(locations) {
        if (locations.length < 3) return false;

        const firstLoc = locations[0];
        const lastLoc = locations[locations.length - 1];

        const totalDistance = this.calculateHaversineDistance(
            firstLoc.latitude,
            firstLoc.longitude,
            lastLoc.latitude,
            lastLoc.longitude
        ) * 1000;

        if (totalDistance < this.PARKING_LOT_RADIUS_METERS) {
            logger.warn(`⚠️ Circular movement detected: ${locations.length} points, ${totalDistance.toFixed(1)}m net displacement`);
            return true;
        }

        return false;
    }

    static async mergeNearbyTrips(vehicleId, macIdGps) {
        try {
            logger.info(`🔄 Checking for trips to merge for vehicle ${vehicleId}...`);

            const recentTrips = await Trip.findAll({
                where: {
                    vehicle_id: vehicleId,
                    mac_id_gps: macIdGps,
                    status: 'completed'
                },
                order: [['start_time', 'DESC']],
                limit: 10,
                raw: true
            });

            if (recentTrips.length < 2) {
                logger.debug(`ℹ️ Not enough trips to merge (found ${recentTrips.length})`);
                return 0;
            }

            let mergeCount = 0;

            for (let i = 0; i < recentTrips.length - 1; i++) {
                const trip1 = recentTrips[i + 1];
                const trip2 = recentTrips[i];

                const gapMinutes = (new Date(trip2.start_time) - new Date(trip1.end_time)) / 60000;

                if (gapMinutes > 0 && gapMinutes <= this.TRIP_MERGE_THRESHOLD_MINUTES) {
                    logger.info(`🔗 Merging trips ${trip1.id} and ${trip2.id} (gap: ${gapMinutes.toFixed(1)} min)`);

                    const merged = await this.mergeTwoTrips(trip1, trip2);
                    if (merged) {
                        mergeCount++;
                        recentTrips.splice(i, 1);
                        i--;
                    }
                }
            }

            if (mergeCount > 0) {
                logger.info(`✅ Merged ${mergeCount} trip pairs`);
            }

            return mergeCount;

        } catch (error) {
            logger.error("🔥 Error merging trips:", error);
            return 0;
        }
    }

    static async mergeTwoTrips(trip1, trip2) {
        const transaction = await sequelize.transaction();

        try {
            logger.debug(`🔗 Merging trip ${trip1.id} with trip ${trip2.id}`);

            const waypoints1 = await TripWaypoint.findAll({
                where: { trip_id: trip1.id },
                order: [['sequence_order', 'ASC']],
                raw: true,
                transaction
            });

            const waypoints2 = await TripWaypoint.findAll({
                where: { trip_id: trip2.id },
                order: [['sequence_order', 'ASC']],
                raw: true,
                transaction
            });

            const allWaypoints = [...waypoints1, ...waypoints2];
            const metrics = this.calculateTripMetrics(allWaypoints);

            await Trip.update({
                end_time: trip2.end_time,
                end_latitude: trip2.end_latitude,
                end_longitude: trip2.end_longitude,
                end_address: trip2.end_address,
                end_address_status: trip2.end_address_status || 'geocoded',
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh: parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh: Math.max(trip1.max_speed_kmh, trip2.max_speed_kmh),
                waypoint_count: allWaypoints.length
            }, {
                where: { id: trip1.id },
                transaction
            });

            const offset = waypoints1.length;
            await TripWaypoint.update(
                {
                    trip_id: trip1.id,
                    sequence_order: sequelize.literal(`sequence_order + ${offset}`)
                },
                {
                    where: { trip_id: trip2.id },
                    transaction
                }
            );

            await Location.update(
                { trip_id: trip1.id },
                { where: { trip_id: trip2.id }, transaction }
            );

            await Trip.destroy({
                where: { id: trip2.id },
                transaction
            });

            await transaction.commit();

            logger.info(`✅ Successfully merged trip ${trip2.id} into trip ${trip1.id}`);
            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`🔥 Error merging trips:`, error);
            return false;
        }
    }

    // ==================== TRIP OPERATIONS ====================

    /**
     * ✅ UPDATED: Create trip with IMMEDIATE geocoding
     */
    static async createNewTrip(vehicleId, macIdGps, startLocation) {
        try {
            logger.info(`🗺️ Geocoding start address...`);

            const startAddressData = await this.reverseGeocode(
                startLocation.latitude,
                startLocation.longitude
            );

            const trip = await Trip.create({
                vehicle_id: vehicleId,
                mac_id_gps: macIdGps,
                start_time: startLocation.sys_time,
                end_time: startLocation.sys_time,
                start_latitude: startLocation.latitude,
                start_longitude: startLocation.longitude,
                start_address: startAddressData.address,
                start_address_status: startAddressData.status,
                end_latitude: startLocation.latitude,
                end_longitude: startLocation.longitude,
                end_address: startAddressData.address,
                end_address_status: startAddressData.status,
                status: 'ongoing',
                duration_minutes: 0,
                total_distance_km: 0,
                avg_speed_kmh: 0,
                max_speed_kmh: 0,
                waypoint_count: 0
            });

            logger.info(`✅ Created trip ${trip.id} with start address: "${startAddressData.address}"`);

            return {
                id: trip.id,
                vehicle_id: vehicleId,
                mac_id_gps: macIdGps,
                start_time: startLocation.sys_time,
                end_time: startLocation.sys_time,
                status: 'ongoing',
                currentWaypointCount: 0
            };

        } catch (error) {
            logger.error("🔥 Error creating trip:", error);
            return null;
        }
    }

    static async updateOngoingTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            if (newWaypoints.length > 0) {
                const correctedWaypoints = this.smoothPath(newWaypoints, 3);

                const waypointsToInsert = correctedWaypoints.map(w => ({
                    ...w,
                    trip_id: currentTrip.id
                }));

                if (waypointsToInsert.length > this.WAYPOINT_BATCH_SIZE) {
                    for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                        const batch = waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE);
                        await TripWaypoint.bulkCreate(batch, { transaction });
                    }
                    logger.debug(`📊 Added ${waypointsToInsert.length} corrected waypoints in ${Math.ceil(waypointsToInsert.length / this.WAYPOINT_BATCH_SIZE)} batches`);
                } else {
                    await TripWaypoint.bulkCreate(waypointsToInsert, { transaction });
                    logger.debug(`📍 Added ${correctedWaypoints.length} corrected waypoints to trip ${currentTrip.id}`);
                }
            }

            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                attributes: ['latitude', 'longitude', 'speed', 'recorded_at'],
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            await Trip.update({
                end_time: endLocation.sys_time,
                end_latitude: endLocation.latitude,
                end_longitude: endLocation.longitude,
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh: parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh: parseFloat(metrics.maxSpeed.toFixed(2)),
                waypoint_count: allWaypoints.length
            }, {
                where: { id: currentTrip.id },
                transaction
            });

            if (locationIds.length > 0) {
                await Location.update(
                    { processed: true, trip_id: currentTrip.id },
                    { where: { id: locationIds }, transaction }
                );
            }

            await transaction.commit();

            logger.info(`✅ Updated ongoing trip ${currentTrip.id}:`, {
                waypoints: allWaypoints.length,
                duration: `${Math.round(metrics.durationMinutes)} min`,
                distance: `${metrics.totalDistanceKm.toFixed(2)} km`
            });

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`🔥 Error updating ongoing trip ${currentTrip.id}:`, error);
            return false;
        }
    }

    /**
     * ✅ UPDATED: Finalize trip with IMMEDIATE end address geocoding
     */
    static async finalizeTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            if (newWaypoints.length > 0) {
                const correctedWaypoints = this.smoothPath(newWaypoints, 3);

                const waypointsToInsert = correctedWaypoints.map(w => ({
                    ...w,
                    trip_id: currentTrip.id
                }));

                if (waypointsToInsert.length > this.WAYPOINT_BATCH_SIZE) {
                    for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                        const batch = waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE);
                        await TripWaypoint.bulkCreate(batch, { transaction });
                    }
                } else {
                    await TripWaypoint.bulkCreate(waypointsToInsert, { transaction });
                }
            }

            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                attributes: ['latitude', 'longitude', 'speed', 'recorded_at'],
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction
            });

            logger.info(`📍 Trip ${currentTrip.id}: ${allWaypoints.length} raw waypoints before simplification`);
            const simplifiedWaypoints = this.simplifyPath(allWaypoints);

            if (simplifiedWaypoints.length < allWaypoints.length) {
                logger.info(`✅ Path simplified: ${allWaypoints.length} → ${simplifiedWaypoints.length} waypoints (${((1 - simplifiedWaypoints.length / allWaypoints.length) * 100).toFixed(1)}% reduction)`);

                await TripWaypoint.destroy({
                    where: { trip_id: currentTrip.id },
                    transaction
                });

                const simplifiedInserts = simplifiedWaypoints.map((w, idx) => ({
                    trip_id: currentTrip.id,
                    latitude: w.latitude,
                    longitude: w.longitude,
                    speed: w.speed,
                    recorded_at: w.recorded_at,
                    sequence_order: idx + 1
                }));

                await TripWaypoint.bulkCreate(simplifiedInserts, { transaction });
            }

            const finalWaypoints = simplifiedWaypoints.length > 0 ? simplifiedWaypoints : allWaypoints;
            const metrics = this.calculateTripMetrics(finalWaypoints);

            if (metrics.durationMinutes < this.MIN_TRIP_DURATION_MIN ||
                metrics.totalDistanceKm < this.MIN_TRIP_DISTANCE_KM) {

                logger.warn(`⚠️ Trip ${currentTrip.id} doesn't meet minimum requirements - deleting`, {
                    duration: `${metrics.durationMinutes.toFixed(1)} min (min: ${this.MIN_TRIP_DURATION_MIN})`,
                    distance: `${metrics.totalDistanceKm.toFixed(2)} km (min: ${this.MIN_TRIP_DISTANCE_KM})`,
                });

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
                logger.info(`🗑️ Trip ${currentTrip.id} deleted successfully (doesn't meet minimums)`);
                return false;
            }

            logger.info(`🗺️ Geocoding end address...`);
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
                waypoint_count: finalWaypoints.length,
                status: 'completed'
            }, {
                where: { id: currentTrip.id },
                transaction
            });

            await Location.update(
                { processed: true, trip_id: currentTrip.id },
                { where: { id: locationIds }, transaction }
            );

            await transaction.commit();

            logger.info(`✅ Trip ${currentTrip.id} finalized with end address: "${endAddressData.address}"`, {
                duration: `${Math.round(metrics.durationMinutes)} min`,
                distance: `${metrics.totalDistanceKm.toFixed(2)} km`,
                avgSpeed: `${metrics.avgSpeed.toFixed(2)} km/h`,
                maxSpeed: `${metrics.maxSpeed.toFixed(2)} km/h`,
                waypoints: finalWaypoints.length
            });

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`🔥 Error finalizing trip ${currentTrip.id}:`, error);
            return false;
        }
    }

    // ==================== HELPER FUNCTIONS ====================
    static prepareWaypoint(location, sequenceOrder) {
        return {
            latitude: location.latitude,
            longitude: location.longitude,
            speed: location.speed || 0,
            recorded_at: location.sys_time,
            sequence_order: sequenceOrder
        };
    }

    static calculateTripMetrics(waypoints) {
        if (!waypoints || waypoints.length === 0) {
            return {
                totalDistanceKm: 0,
                durationMinutes: 0,
                avgSpeed: 0,
                maxSpeed: 0
            };
        }

        let totalDistance = 0;
        let maxSpeed = 0;
        let sumSpeed = 0;
        let speedCount = 0;

        for (let i = 1; i < waypoints.length; i++) {
            const prev = waypoints[i - 1];
            const curr = waypoints[i];

            const distance = this.calculateHaversineDistance(
                Number(prev.latitude),
                Number(prev.longitude),
                Number(curr.latitude),
                Number(curr.longitude)
            );
            totalDistance += distance;

            const speed = Number(curr.speed || 0);
            if (speed > maxSpeed) {
                maxSpeed = speed;
            }
            if (speed > 0) {
                sumSpeed += speed;
                speedCount++;
            }
        }

        const startTime = new Date(waypoints[0].recorded_at);
        const endTime = new Date(waypoints[waypoints.length - 1].recorded_at);
        const durationMinutes = (endTime - startTime) / 60000;

        return {
            totalDistanceKm: totalDistance,
            durationMinutes: Math.max(0, durationMinutes),
            avgSpeed: speedCount > 0 ? sumSpeed / speedCount : 0,
            maxSpeed
        };
    }

    static calculateHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;

        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(lat1)) *
            Math.cos(this.toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    static toRadians(degrees) {
        return degrees * Math.PI / 180;
    }

    static toDegrees(radians) {
        return radians * 180 / Math.PI;
    }
}

module.exports = TripDetectionService;