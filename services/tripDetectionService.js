// services/tripDetectionService.js
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
    // ==================== CONFIGURATION ====================
    static IDLE_THRESHOLD_MINUTES = Number(process.env.TRIP_IDLE_MINUTES ?? 0.5);
    static MIN_SPEED_THRESHOLD = Number(process.env.TRIP_MIN_SPEED_KMH ?? 1);
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION ?? 1);
    static MIN_TRIP_DISTANCE_KM = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 0.2);

    // 🆕 Performance settings
    static MAX_LOCATIONS_PER_BATCH = 5000; // Process locations in batches
    static WAYPOINT_BATCH_SIZE = 500; // Bulk insert waypoints in batches

    // ==================== MAIN ENTRY POINT ====================
    /**
     * Main function to detect and create trips from unprocessed locations
     */
    static async detectAndCreateTrips() {
        logger.info("=== TRIP DETECTION START ===");

        try {
            const macs = await this.getVehiclesWithUnprocessedData();

            if (macs.length === 0) {
                logger.debug("No vehicles with unprocessed data");
                return { success: true, tripsCreated: 0, vehiclesProcessed: 0 };
            }

            logger.info(`Found ${macs.length} vehicles with unprocessed data`);

            let totalTrips = 0;
            let skipped = 0;
            let errors = 0;

            for (const mac of macs) {
                try {
                    const res = await this.processVehicleLocations(mac);
                    if (res.skipped) skipped++;
                    totalTrips += res.tripsCreated;
                } catch (error) {
                    logger.error(`Error processing vehicle ${mac}:`, error);
                    errors++;
                }
            }

            logger.info("=== TRIP DETECTION COMPLETE ===", {
                tripsCreated: totalTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped: skipped,
                errors
            });

            return {
                success: true,
                tripsCreated: totalTrips,
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped: skipped,
                errors
            };

        } catch (error) {
            logger.error("Fatal error in trip detection:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 🆕 OPTIMIZED: Get list of vehicles with unprocessed location data
     * Uses index: idx_locations_processed
     */
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
            logger.error("Error fetching vehicles with unprocessed data:", error);
            return [];
        }
    }

    // ==================== VEHICLE PROCESSING ====================
    /**
     * 🆕 OPTIMIZED: Process all unprocessed locations for a specific vehicle
     * Uses index: idx_locations_mac_processed_time
     */
    static async processVehicleLocations(macIdGps) {
        logger.debug(`Processing vehicle: ${macIdGps}`);

        try {
            // 🆕 Count unprocessed locations first to determine batching strategy
            const locationCount = await Location.count({
                where: { mac_id_gps: macIdGps, processed: false }
            });

            if (locationCount === 0) {
                logger.debug(`No unprocessed locations for ${macIdGps}`);
                return { skipped: false, tripsCreated: 0 };
            }

            logger.debug(`Found ${locationCount} unprocessed locations for ${macIdGps}`);

            // 🆕 OPTIMIZED: Fetch vehicle with only needed attributes
            const vehicle = await Voiture.findOne({
                where: { mac_id_gps: macIdGps },
                attributes: ["id", "immatriculation"],
                raw: true
            });

            if (!vehicle) {
                logger.warn(`Vehicle not found for MAC: ${macIdGps} - marking locations as processed`);
                await Location.update(
                    { processed: true },
                    { where: { mac_id_gps: macIdGps, processed: false } }
                );
                return { skipped: false, tripsCreated: 0 };
            }

            logger.debug(`Vehicle found: ${vehicle.immatriculation} (ID: ${vehicle.id})`);

            // 🆕 OPTIMIZED: Check trip tracking with minimal query
            const userCheck = await this.checkUserTripTracking(vehicle.id);

            if (!userCheck.enabled) {
                logger.debug(`Trip tracking disabled for vehicle ${vehicle.id} - ${userCheck.reason}`);
                await Location.update(
                    { processed: true },
                    { where: { mac_id_gps: macIdGps, processed: false } }
                );
                return { skipped: true, tripsCreated: 0 };
            }

            logger.debug(`Trip tracking enabled for vehicle ${vehicle.id} - processing trips`);

            // 🆕 Get ongoing trip if exists (uses new indexes)
            const ongoingTrip = await this.getOngoingTrip(vehicle.id, macIdGps);

            // 🆕 BATCH PROCESSING: Process locations in chunks if too many
            let totalTripsProcessed = 0;

            if (locationCount > this.MAX_LOCATIONS_PER_BATCH) {
                logger.info(`Large location set (${locationCount}), using batch processing`);

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

                    const tripsProcessed = await this.detectAndProcessTrips(
                        locations,
                        vehicle.id,
                        macIdGps,
                        currentTrip
                    );

                    totalTripsProcessed += tripsProcessed;
                    offset += this.MAX_LOCATIONS_PER_BATCH;

                    // Get updated ongoing trip for next batch
                    currentTrip = await this.getOngoingTrip(vehicle.id, macIdGps);
                }
            } else {
                // 🆕 OPTIMIZED: Single fetch for smaller datasets
                // Uses index: idx_locations_mac_processed_time
                const locations = await Location.findAll({
                    where: { mac_id_gps: macIdGps, processed: false },
                    order: [["sys_time", "ASC"]],
                    attributes: ['id', 'latitude', 'longitude', 'speed', 'sys_time'], // Only needed fields
                    raw: true
                });

                totalTripsProcessed = await this.detectAndProcessTrips(
                    locations,
                    vehicle.id,
                    macIdGps,
                    ongoingTrip
                );
            }

            logger.info(`Processed ${totalTripsProcessed} trips for vehicle ${vehicle.immatriculation}`);
            return { skipped: false, tripsCreated: totalTripsProcessed };

        } catch (error) {
            logger.error(`Error processing vehicle locations for ${macIdGps}:`, error);
            throw error;
        }
    }

    /**
     * 🆕 OPTIMIZED: Check if user has trip tracking enabled
     */
    static async checkUserTripTracking(vehicleId) {
        try {
            // 🆕 Single optimized query with JOIN
            const result = await AssocUserVoitures.findOne({
                where: { voiture_id: vehicleId },
                include: [{
                    model: User,
                    as: 'user',
                    attributes: ['id', 'trip_tracking_enabled'],
                    required: true
                }],
                attributes: ['user_id'],
                raw: true,
                nest: true
            });

            if (!result) {
                return { enabled: false, reason: "No user associated with vehicle" };
            }

            if (!result.user || !result.user.trip_tracking_enabled) {
                return { enabled: false, reason: "Trip tracking disabled by user" };
            }

            return { enabled: true, userId: result.user.id };

        } catch (error) {
            logger.error(`Error checking user trip tracking for vehicle ${vehicleId}:`, error);
            return { enabled: false, reason: "Error checking settings" };
        }
    }

    /**
     * 🆕 OPTIMIZED: Get ongoing trip for a vehicle
     * Uses index: idx_trips_vehicle_status_time
     */
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
                logger.debug(`Found ongoing trip ${ongoingTrip.id} started at ${ongoingTrip.start_time}`);

                // 🆕 OPTIMIZED: Get waypoint count (uses idx_trip_waypoints_trip_id)
                const waypointCount = await TripWaypoint.count({
                    where: { trip_id: ongoingTrip.id }
                });

                return {
                    ...ongoingTrip,
                    currentWaypointCount: waypointCount
                };
            }

            logger.debug("No ongoing trip found");
            return null;

        } catch (error) {
            logger.error("Error fetching ongoing trip:", error);
            return null;
        }
    }

    // ==================== TRIP DETECTION LOGIC ====================
    /**
     * Main trip detection algorithm
     * Processes locations and creates/updates trips based on movement patterns
     */
    static async detectAndProcessTrips(locations, vehicleId, macIdGps, ongoingTrip) {
        let tripsProcessed = 0;
        let currentTrip = ongoingTrip;
        let lastMovingTime = null;
        let newLocationIds = [];
        let newWaypoints = [];

        // If continuing trip, set the last moving time
        if (currentTrip) {
            lastMovingTime = new Date(currentTrip.end_time);
            logger.debug(`Continuing trip ${currentTrip.id} from ${lastMovingTime}`);
        }

        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];
            const speed = Number(loc.speed || 0);
            const isMoving = speed >= this.MIN_SPEED_THRESHOLD;
            const locTime = new Date(loc.sys_time);

            // START NEW TRIP
            if (!currentTrip && isMoving) {
                logger.info(`Starting new trip at ${loc.sys_time} (speed: ${speed} km/h)`);

                currentTrip = await this.createNewTrip(vehicleId, macIdGps, loc);

                if (!currentTrip) {
                    logger.error("Failed to create new trip - skipping location");
                    continue;
                }

                newLocationIds = [loc.id];
                newWaypoints = [this.prepareWaypoint(loc, 1)];
                lastMovingTime = locTime;
                continue;
            }

            // CONTINUE EXISTING TRIP
            if (currentTrip) {
                newLocationIds.push(loc.id);

                const sequenceOrder = currentTrip.currentWaypointCount
                    ? currentTrip.currentWaypointCount + newWaypoints.length + 1
                    : newWaypoints.length + 1;

                newWaypoints.push(this.prepareWaypoint(loc, sequenceOrder));

                if (isMoving) {
                    // Vehicle is moving - update last moving time
                    lastMovingTime = locTime;
                } else {
                    // Vehicle is stopped - check if idle long enough
                    const idleMinutes = (locTime - lastMovingTime) / 60000;

                    if (idleMinutes >= this.IDLE_THRESHOLD_MINUTES) {
                        // END TRIP - Vehicle has been idle too long
                        logger.debug(`Ending trip ${currentTrip.id} after ${idleMinutes.toFixed(1)} min idle`);

                        const saved = await this.finalizeTrip(
                            currentTrip,
                            loc,
                            newWaypoints,
                            newLocationIds
                        );

                        if (saved) tripsProcessed++;

                        // Reset for next trip
                        currentTrip = null;
                        lastMovingTime = null;
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
                // Trip should end
                logger.debug(`Finalizing trip ${currentTrip.id} - idle for ${idleMinutes.toFixed(1)} min`);
                const saved = await this.finalizeTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                if (saved) tripsProcessed++;
            } else {
                // Trip is still ongoing - just update it
                logger.debug(`Trip ${currentTrip.id} still ongoing - updating (idle: ${idleMinutes.toFixed(1)} min)`);
                const updated = await this.updateOngoingTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                if (updated) tripsProcessed++;
            }
        }

        return tripsProcessed;
    }

    // ==================== TRIP OPERATIONS ====================
    /**
     * 🆕 OPTIMIZED: Create a new trip with cached geocoding
     */
    static async createNewTrip(vehicleId, macIdGps, startLocation) {
        try {
            // 🆕 Geocoding can be slow - do it async or cache results
            let startAddress = "Unknown location";
            try {
                startAddress = await Promise.race([
                    GeocodingService.getAddress(startLocation.latitude, startLocation.longitude),
                    new Promise((resolve) => setTimeout(() => resolve("Location pending..."), 2000))
                ]);
                startAddress = startAddress || "Unknown location";
            } catch (geocodeError) {
                logger.warn(`Geocoding failed for trip start, using default: ${geocodeError.message}`);
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

            logger.info(`Created new trip ${trip.id} for vehicle ${vehicleId}`);

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
            logger.error("Error creating trip:", error);
            return null;
        }
    }

    /**
     * 🆕 OPTIMIZED: Update an ongoing trip with batched waypoint insertion
     */
    static async updateOngoingTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            // 🆕 BATCH INSERT waypoints for better performance
            if (newWaypoints.length > 0) {
                const waypointsToInsert = newWaypoints.map(w => ({
                    ...w,
                    trip_id: currentTrip.id
                }));

                // Insert in batches if too many
                if (waypointsToInsert.length > this.WAYPOINT_BATCH_SIZE) {
                    for (let i = 0; i < waypointsToInsert.length; i += this.WAYPOINT_BATCH_SIZE) {
                        const batch = waypointsToInsert.slice(i, i + this.WAYPOINT_BATCH_SIZE);
                        await TripWaypoint.bulkCreate(batch, { transaction });
                    }
                    logger.debug(`Added ${waypointsToInsert.length} waypoints in ${Math.ceil(waypointsToInsert.length / this.WAYPOINT_BATCH_SIZE)} batches`);
                } else {
                    await TripWaypoint.bulkCreate(waypointsToInsert, { transaction });
                    logger.debug(`Added ${newWaypoints.length} waypoints to trip ${currentTrip.id}`);
                }
            }

            // 🆕 OPTIMIZED: Get waypoints with only needed attributes
            // Uses index: idx_trip_waypoints_trip_sequence
            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                attributes: ['latitude', 'longitude', 'speed', 'recorded_at'],
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            // Update trip
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

            // 🆕 BATCH UPDATE locations
            if (locationIds.length > 0) {
                await Location.update(
                    { processed: true, trip_id: currentTrip.id },
                    { where: { id: locationIds }, transaction }
                );
            }

            await transaction.commit();

            logger.info(`Updated ongoing trip ${currentTrip.id}:`, {
                waypoints: allWaypoints.length,
                duration: `${Math.round(metrics.durationMinutes)} min`,
                distance: `${metrics.totalDistanceKm.toFixed(2)} km`
            });

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`Error updating ongoing trip ${currentTrip.id}:`, error);
            return false;
        }
    }

    /**
     * 🆕 OPTIMIZED: Finalize a trip with batched operations
     */
    static async finalizeTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const transaction = await sequelize.transaction();

        try {
            // 🆕 BATCH INSERT waypoints
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

            // 🆕 OPTIMIZED: Get waypoints with minimal attributes
            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                attributes: ['latitude', 'longitude', 'speed', 'recorded_at'],
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            // Check if trip meets minimum criteria
            if (metrics.durationMinutes < this.MIN_TRIP_DURATION_MIN ||
                metrics.totalDistanceKm < this.MIN_TRIP_DISTANCE_KM) {

                logger.warn(`Trip ${currentTrip.id} too short - deleting`, {
                    duration: `${metrics.durationMinutes.toFixed(1)} min`,
                    distance: `${metrics.totalDistanceKm.toFixed(2)} km`,
                    minDuration: `${this.MIN_TRIP_DURATION_MIN} min`,
                    minDistance: `${this.MIN_TRIP_DISTANCE_KM} km`
                });

                // Delete in correct order to respect foreign key constraints
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
                logger.info(`Trip ${currentTrip.id} deleted successfully (too short)`);
                return false;
            }

            // 🆕 Get end address with timeout
            let endAddress = "Unknown location";
            try {
                endAddress = await Promise.race([
                    GeocodingService.getAddress(endLocation.latitude, endLocation.longitude),
                    new Promise((resolve) => setTimeout(() => resolve("Location pending..."), 2000))
                ]);
                endAddress = endAddress || "Unknown location";
            } catch (geocodeError) {
                logger.warn(`Geocoding failed for trip end, using default: ${geocodeError.message}`);
            }

            // Finalize trip
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

            // Mark locations as processed
            await Location.update(
                { processed: true, trip_id: currentTrip.id },
                { where: { id: locationIds }, transaction }
            );

            await transaction.commit();

            logger.info(`Trip ${currentTrip.id} finalized:`, {
                duration: `${Math.round(metrics.durationMinutes)} min`,
                distance: `${metrics.totalDistanceKm.toFixed(2)} km`,
                avgSpeed: `${metrics.avgSpeed.toFixed(2)} km/h`,
                maxSpeed: `${metrics.maxSpeed.toFixed(2)} km/h`,
                waypoints: allWaypoints.length
            });

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`Error finalizing trip ${currentTrip.id}:`, error);
            return false;
        }
    }

    // ==================== HELPER FUNCTIONS ====================
    /**
     * Prepare waypoint data for insertion
     */
    static prepareWaypoint(location, sequenceOrder) {
        return {
            latitude: location.latitude,
            longitude: location.longitude,
            speed: location.speed || 0,
            recorded_at: location.sys_time,
            sequence_order: sequenceOrder
        };
    }

    /**
     * Calculate trip metrics from waypoints
     */
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

        // Calculate distance and speed metrics
        for (let i = 1; i < waypoints.length; i++) {
            const prev = waypoints[i - 1];
            const curr = waypoints[i];

            // Calculate distance between consecutive waypoints
            const distance = this.calculateHaversineDistance(
                Number(prev.latitude),
                Number(prev.longitude),
                Number(curr.latitude),
                Number(curr.longitude)
            );
            totalDistance += distance;

            // Track speed metrics
            const speed = Number(curr.speed || 0);
            if (speed > maxSpeed) {
                maxSpeed = speed;
            }
            if (speed > 0) {
                sumSpeed += speed;
                speedCount++;
            }
        }

        // Calculate duration
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

    /**
     * Calculate distance between two coordinates using Haversine formula
     * Returns distance in kilometers
     */
    static calculateHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in kilometers

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

    /**
     * Convert degrees to radians
     */
    static toRadians(degrees) {
        return degrees * Math.PI / 180;
    }
}

module.exports = TripDetectionService;