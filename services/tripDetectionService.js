// services/tripDetectionService.js - ENHANCED TRIP DETECTION WITH GPS DRIFT FILTERING
const { Op } = require("sequelize");
const Location = require("../models/location");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const GeocodingService = require("./geocodingService");
const sequelize = require("../config/database");
const logger = require("../utils/logger");

class TripDetectionService {
    // ==================== ENHANCED CONFIGURATION ====================

    // 🚗 TRIP DETECTION THRESHOLDS
    static IDLE_THRESHOLD_MINUTES = Number(process.env.TRIP_IDLE_MINUTES ?? 10); // 10 minutes idle = trip end
    static MIN_SPEED_THRESHOLD = Number(process.env.TRIP_MIN_SPEED_KMH ?? 10); // ✅ INCREASED: 10 km/h = actual movement
    static TRIP_MERGE_THRESHOLD_MINUTES = Number(process.env.TRIP_MERGE_MINUTES ?? 3); // Merge trips with <3 min gaps

    // 🎯 MINIMUM TRIP REQUIREMENTS (Stricter standards)
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION ?? 5); // 5 minutes minimum
    static MIN_TRIP_DISTANCE_KM = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 1.5); // ✅ INCREASED: 1.5 km minimum

    // 📍 GPS DRIFT DETECTION (Prevents false trips when parked)
    static GPS_DRIFT_THRESHOLD_METERS = Number(process.env.GPS_DRIFT_METERS ?? 100); // ✅ INCREASED: 100m = GPS noise radius
    static MAX_PARKED_SPEED = 3; // km/h - anything below is considered "parked"

    // 🆕 TRIP START CONFIRMATION (Requires sustained movement)
    static MIN_CONSECUTIVE_MOVING_POINTS = 5; // ✅ NEW: Need 5 moving points to start trip
    static MIN_DISTANCE_TO_START_TRIP_METERS = 200; // ✅ NEW: Must travel 200m to confirm trip
    static PARKING_LOT_RADIUS_METERS = 100; // ✅ NEW: Detect circular movement in parking lots

    // ⚡ PERFORMANCE SETTINGS
    static MAX_LOCATIONS_PER_BATCH = 5000;
    static WAYPOINT_BATCH_SIZE = 500;

    // ==================== MAIN ENTRY POINT ====================
    static async detectAndCreateTrips() {
        logger.info("=== 🚀 ENHANCED TRIP DETECTION START ===");

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

            // POST-PROCESSING: Merge nearby trips
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
    /**
     * 🆕 ENHANCED: Detects real trips with strict GPS drift filtering
     */
    static async detectAndProcessTrips(locations, vehicleId, macIdGps, ongoingTrip) {
        let tripsCreated = 0;
        let tripsMerged = 0;
        let currentTrip = ongoingTrip;
        let lastMovingTime = null;
        let lastRealPosition = null;
        let newLocationIds = [];
        let newWaypoints = [];

        // 🆕 TRIP START CONFIRMATION BUFFERS
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

            // 🆕 Calculate actual speed from GPS coordinates
            const calculatedSpeed = this.calculateSpeedFromGPS(lastRealPosition, loc, locTime);
            const actualSpeed = Math.max(reportedSpeed, calculatedSpeed); // Use whichever is higher

            // 🆕 Enhanced GPS drift detection
            const isRealMovement = this.isRealMovement(loc, lastRealPosition, actualSpeed);
            const isMoving = actualSpeed >= this.MIN_SPEED_THRESHOLD && isRealMovement;

            logger.debug(`📍 Location ${i + 1}/${locations.length}: reported=${reportedSpeed.toFixed(1)} km/h, calculated=${calculatedSpeed.toFixed(1)} km/h, moving=${isMoving}, drift=${!isRealMovement}`);

            // ========== NO ONGOING TRIP - CHECK IF WE SHOULD START ONE ==========
            if (!currentTrip) {
                if (isMoving) {
                    // Add to consecutive moving points buffer
                    consecutiveMovingPoints.push(loc);
                    tripStartBuffer.push(loc);

                    // Calculate distance traveled in buffer
                    if (tripStartBuffer.length > 1) {
                        const lastBufferLoc = tripStartBuffer[tripStartBuffer.length - 2];
                        const dist = this.calculateHaversineDistance(
                            lastBufferLoc.latitude,
                            lastBufferLoc.longitude,
                            loc.latitude,
                            loc.longitude
                        ) * 1000; // Convert to meters
                        totalDistanceTraveled += dist;
                    }

                    // 🆕 CHECK IF WE HAVE ENOUGH CONFIRMATION TO START TRIP
                    if (consecutiveMovingPoints.length >= this.MIN_CONSECUTIVE_MOVING_POINTS &&
                        totalDistanceTraveled >= this.MIN_DISTANCE_TO_START_TRIP_METERS) {

                        // 🆕 Final check: Is this circular movement (parking lot drift)?
                        const isCircularMovement = this.isCircularMovement(tripStartBuffer);

                        if (isCircularMovement) {
                            logger.warn(`⚠️ Circular movement detected (parking lot drift) - NOT starting trip`);
                            consecutiveMovingPoints = [];
                            tripStartBuffer = [];
                            totalDistanceTraveled = 0;
                            continue;
                        }

                        // ✅ ALL CHECKS PASSED - START TRIP
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

                        // Add all buffered points to trip
                        newLocationIds = tripStartBuffer.map(l => l.id);
                        newWaypoints = tripStartBuffer.map((l, idx) => this.prepareWaypoint(l, idx + 1));

                        lastMovingTime = locTime;
                        lastRealPosition = { lat: loc.latitude, lng: loc.longitude };

                        // Reset buffers
                        consecutiveMovingPoints = [];
                        tripStartBuffer = [];
                        totalDistanceTraveled = 0;
                    }
                } else {
                    // Not moving - reset buffers
                    if (consecutiveMovingPoints.length > 0) {
                        logger.debug(`⚠️ Movement interrupted - resetting trip start buffers (had ${consecutiveMovingPoints.length} points, ${totalDistanceTraveled.toFixed(0)}m)`);
                    }
                    consecutiveMovingPoints = [];
                    tripStartBuffer = [];
                    totalDistanceTraveled = 0;
                }
                continue;
            }

            // ========== ONGOING TRIP - CONTINUE OR END ==========
            if (currentTrip) {
                newLocationIds.push(loc.id);

                const sequenceOrder = currentTrip.currentWaypointCount
                    ? currentTrip.currentWaypointCount + newWaypoints.length + 1
                    : newWaypoints.length + 1;

                newWaypoints.push(this.prepareWaypoint(loc, sequenceOrder));

                if (isMoving) {
                    // Vehicle is actually moving
                    lastMovingTime = locTime;
                    lastRealPosition = { lat: loc.latitude, lng: loc.longitude };
                    logger.debug(`✅ Trip ${currentTrip.id} continues (speed: ${actualSpeed.toFixed(1)} km/h)`);
                } else {
                    // Vehicle stopped or GPS drift
                    const idleMinutes = (locTime - lastMovingTime) / 60000;

                    logger.debug(`⏸️ Vehicle idle for ${idleMinutes.toFixed(1)} min (threshold: ${this.IDLE_THRESHOLD_MINUTES} min)`);

                    if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                        // END TRIP
                        logger.info(`🛑 Ending trip ${currentTrip.id} after ${idleMinutes.toFixed(1)} min idle`);

                        const saved = await this.finalizeTrip(
                            currentTrip,
                            loc,
                            newWaypoints,
                            newLocationIds
                        );

                        if (saved) tripsCreated++;

                        // Reset for next trip
                        currentTrip = null;
                        lastMovingTime = null;
                        lastRealPosition = null;
                        newLocationIds = [];
                        newWaypoints = [];
                    }
                }
            }
        }

        // HANDLE ONGOING TRIP AT END
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

        return { tripsCreated, tripsMerged };
    }

    /**
     * 🆕 Calculate speed from GPS coordinates (more reliable than reported speed)
     */
    static calculateSpeedFromGPS(lastPosition, currentLoc, currentTime) {
        if (!lastPosition || !lastPosition.time) return 0;

        const distanceKm = this.calculateHaversineDistance(
            lastPosition.lat,
            lastPosition.lng,
            currentLoc.latitude,
            currentLoc.longitude
        );

        const timeDiffHours = (currentTime - lastPosition.time) / (1000 * 60 * 60);

        if (timeDiffHours === 0) return 0;

        const speed = distanceKm / timeDiffHours;
        return Math.max(0, speed); // Never negative
    }

    /**
     * 🆕 Enhanced GPS DRIFT DETECTION
     */
    static isRealMovement(currentLoc, lastRealPosition, speed) {
        // If no previous position, consider it real movement
        if (!lastRealPosition) return true;

        // If speed is very low, likely just GPS drift
        if (speed < this.MAX_PARKED_SPEED) {
            const distance = this.calculateHaversineDistance(
                lastRealPosition.lat,
                lastRealPosition.lng,
                currentLoc.latitude,
                currentLoc.longitude
            ) * 1000; // Convert to meters

            // If moved less than threshold, it's GPS drift
            if (distance < this.GPS_DRIFT_THRESHOLD_METERS) {
                logger.debug(`📍 GPS drift detected: ${distance.toFixed(1)}m movement at ${speed.toFixed(1)} km/h`);
                return false;
            }
        }

        return true;
    }

    /**
     * 🆕 Detect circular movement (parking lot drift pattern)
     */
    static isCircularMovement(locations) {
        if (locations.length < 3) return false;

        const firstLoc = locations[0];
        const lastLoc = locations[locations.length - 1];

        // Calculate distance between first and last point
        const totalDistance = this.calculateHaversineDistance(
            firstLoc.latitude,
            firstLoc.longitude,
            lastLoc.latitude,
            lastLoc.longitude
        ) * 1000; // Convert to meters

        // If we're back within parking lot radius, this is circular movement
        if (totalDistance < this.PARKING_LOT_RADIUS_METERS) {
            logger.warn(`⚠️ Circular movement detected: ${locations.length} points, ${totalDistance.toFixed(1)}m net displacement`);
            return true;
        }

        return false;
    }

    /**
     * TRIP MERGING: Combines trips with short breaks
     */
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

    /**
     * Merge two consecutive trips into one
     */
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
    static async createNewTrip(vehicleId, macIdGps, startLocation) {
        try {
            let startAddress = "Unknown location";
            try {
                startAddress = await Promise.race([
                    GeocodingService.getAddress(startLocation.latitude, startLocation.longitude),
                    new Promise((resolve) => setTimeout(() => resolve("Location pending..."), 2000))
                ]);
                startAddress = startAddress || "Unknown location";
            } catch (geocodeError) {
                logger.warn(`⚠️ Geocoding failed for trip start: ${geocodeError.message}`);
            }

            const trip = await Trip.create({
                vehicle_id: vehicleId,
                mac_id_gps: macIdGps,
                start_time: startLocation.sys_time,
                end_time: startLocation.sys_time,
                start_latitude: startLocation.latitude,
                start_longitude: startLocation.longitude,
                start_address: startAddress,
                end_latitude: startLocation.latitude,
                end_longitude: startLocation.longitude,
                end_address: startAddress,
                status: 'ongoing',
                duration_minutes: 0,
                total_distance_km: 0,
                avg_speed_kmh: 0,
                max_speed_kmh: 0,
                waypoint_count: 0
            });

            logger.info(`✅ Created new trip ${trip.id} for vehicle ${vehicleId}`);

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
                const waypointsToInsert = newWaypoints.map(w => ({
                    ...w,
                    trip_id: currentTrip.id
                }));

                if (waypointsToInsert.length > this.WAYPOINT_BATCH_SIZE) {
                    for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                        const batch = waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE);
                        await TripWaypoint.bulkCreate(batch, { transaction });
                    }
                    logger.debug(`📊 Added ${waypointsToInsert.length} waypoints in ${Math.ceil(waypointsToInsert.length / this.WAYPOINT_BATCH_SIZE)} batches`);
                } else {
                    await TripWaypoint.bulkCreate(waypointsToInsert, { transaction });
                    logger.debug(`📍 Added ${newWaypoints.length} waypoints to trip ${currentTrip.id}`);
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

    static async finalizeTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            if (newWaypoints.length > 0) {
                const waypointsToInsert = newWaypoints.map(w => ({
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

            const metrics = this.calculateTripMetrics(allWaypoints);

            // ✅ STRICTER MINIMUM REQUIREMENTS
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

            let endAddress = "Unknown location";
            try {
                endAddress = await Promise.race([
                    GeocodingService.getAddress(endLocation.latitude, endLocation.longitude),
                    new Promise((resolve) => setTimeout(() => resolve("Location pending..."), 2000))
                ]);
                endAddress = endAddress || "Unknown location";
            } catch (geocodeError) {
                logger.warn(`⚠️ Geocoding failed for trip end: ${geocodeError.message}`);
            }

            await Trip.update({
                end_time: endLocation.sys_time,
                end_latitude: endLocation.latitude,
                end_longitude: endLocation.longitude,
                end_address: endAddress,
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: parseFloat(metrics.totalDistanceKm.toFixed(2)),
                avg_speed_kmh: parseFloat(metrics.avgSpeed.toFixed(2)),
                max_speed_kmh: parseFloat(metrics.maxSpeed.toFixed(2)),
                waypoint_count: allWaypoints.length,
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

            logger.info(`✅ Trip ${currentTrip.id} finalized:`, {
                duration: `${Math.round(metrics.durationMinutes)} min`,
                distance: `${metrics.totalDistanceKm.toFixed(2)} km`,
                avgSpeed: `${metrics.avgSpeed.toFixed(2)} km/h`,
                maxSpeed: `${metrics.maxSpeed.toFixed(2)} km/h`,
                waypoints: allWaypoints.length
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
}

module.exports = TripDetectionService;