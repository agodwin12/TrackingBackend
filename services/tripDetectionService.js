const { Op } = require("sequelize");
const Location = require("../models/location");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const GeocodingService = require("./geocodingService");
const sequelize = require("../config/database");

class TripDetectionService {
// ---- SETTINGS ----
    static IDLE_THRESHOLD_MINUTES = Number(process.env.TRIP_IDLE_MINUTES ?? 0.5);
    static MIN_SPEED_THRESHOLD = Number(process.env.TRIP_MIN_SPEED_KMH ?? 1);
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION ?? 1);
    static MIN_TRIP_DISTANCE_KM = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 0.2);

    // ======================================================
    // 🔍 Main entry point
    // ======================================================
    static async detectAndCreateTrips() {
        console.log("\n🛰️ === TRIP DETECTION START ===");

        const macs = await this.getVehiclesWithUnprocessedData();
        if (macs.length === 0) {
            console.log("✅ No vehicles with unprocessed data.");
            return;
        }

        let totalTrips = 0;
        let skipped = 0;

        for (const mac of macs) {
            const res = await this.processVehicleLocations(mac);
            if (res.skipped) skipped++;
            totalTrips += res.tripsCreated;
        }

        console.log(`\n🏁 Trip Detection Finished`);
        console.log(`Trips Created/Updated: ${totalTrips}`);
        console.log(`Vehicles Skipped: ${skipped}`);
    }

    static async getVehiclesWithUnprocessedData() {
        const rows = await Location.findAll({
            where: { processed: false },
            attributes: [
                [sequelize.fn("DISTINCT", sequelize.col("mac_id_gps")), "mac_id_gps"],
            ],
            raw: true,
        });
        return rows.map(r => r.mac_id_gps);
    }

    // ======================================================
    // 🚗 MAIN VEHICLE PROCESSING
    // ======================================================
    static async processVehicleLocations(macIdGps) {
        console.log(`\n⚙️ Processing: ${macIdGps}`);

        const locations = await Location.findAll({
            where: { mac_id_gps: macIdGps, processed: false },
            order: [["sys_time", "ASC"]],
            raw: true
        });

        if (locations.length === 0)
            return { skipped: false, tripsCreated: 0 };

        const vehicle = await Voiture.findOne({
            where: { mac_id_gps: macIdGps },
            attributes: ["id", "immatriculation"],
            raw: true
        });

        if (!vehicle) {
            console.log("⚠️ Vehicle NOT FOUND → Mark processed");
            await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps } });
            return { skipped: false, tripsCreated: 0 };
        }

        console.log(`🚗 Vehicle ID: ${vehicle.id} | Plate: ${vehicle.immatriculation}`);

        // Get user and check preferences
        const assoc = await AssocUserVoitures.findOne({
            where: { voiture_id: vehicle.id },
            attributes: ["user_id"],
            raw: true
        });

        if (!assoc) {
            console.log("⚠️ No user mapped to this vehicle → Mark processed");
            await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps } });
            return { skipped: false, tripsCreated: 0 };
        }

        const userId = assoc.user_id;
        const user = await User.findByPk(userId, {
            attributes: ["id", "trip_tracking_enabled"],
            raw: true
        });

        if (!user || !user.trip_tracking_enabled) {
            console.log("🚫 Trip tracking disabled → Mark processed");
            await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps } });
            return { skipped: true, tripsCreated: 0 };
        }

        console.log("✅ Trip tracking ENABLED - Processing trips...");

        // Check for ongoing trip
        const ongoingTrip = await this.getOngoingTrip(vehicle.id, macIdGps);

        // Process locations and detect/update trips
        const tripsProcessed = await this.detectAndProcessTrips(
            locations,
            vehicle.id,
            macIdGps,
            ongoingTrip
        );

        return { skipped: false, tripsCreated: tripsProcessed };
    }

    // ======================================================
    // 🔍 GET ONGOING TRIP
    // ======================================================
    static async getOngoingTrip(vehicleId, macIdGps) {
        try {
            const ongoingTrip = await Trip.findOne({
                where: {
                    vehicle_id: vehicleId,
                    mac_id_gps: macIdGps,
                    status: 'ongoing'
                },
                order: [["created_at", "DESC"]],
                raw: true
            });

            if (ongoingTrip) {
                console.log(`🔄 Found ongoing trip (ID: ${ongoingTrip.id}) started at ${ongoingTrip.start_time}`);

                // Get waypoint count for sequence ordering
                const waypointCount = await TripWaypoint.count({
                    where: { trip_id: ongoingTrip.id }
                });

                return {
                    ...ongoingTrip,
                    currentWaypointCount: waypointCount
                };
            }

            console.log("📍 No ongoing trip found");
            return null;

        } catch (err) {
            console.error("❌ Error fetching ongoing trip:", err);
            return null;
        }
    }

    // ======================================================
    // 🧠 IMPROVED TRIP DETECTION
    // ======================================================
    static async detectAndProcessTrips(locations, vehicleId, macIdGps, ongoingTrip) {
        let tripsProcessed = 0;
        let currentTrip = ongoingTrip;
        let lastMovingTime = null;
        let newLocationIds = [];
        let newWaypoints = [];

        // If continuing trip, set the last moving time
        if (currentTrip) {
            lastMovingTime = new Date(currentTrip.end_time);
            console.log(`📍 Continuing from last known time: ${lastMovingTime}`);
        }

        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];
            const speed = Number(loc.speed || 0);
            const isMoving = speed >= this.MIN_SPEED_THRESHOLD;
            const locTime = new Date(loc.sys_time);

            // START NEW TRIP
            if (!currentTrip && isMoving) {
                console.log(`🚀 Starting new trip at ${loc.sys_time}`);

                currentTrip = await this.createNewTrip(vehicleId, macIdGps, loc);
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
                        console.log(`🛑 Ending trip after ${idleMinutes.toFixed(1)} min idle`);

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
                console.log(`🏁 Finalizing trip - idle for ${idleMinutes.toFixed(1)} min`);
                const saved = await this.finalizeTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                if (saved) tripsProcessed++;
            } else {
                // Trip is still ongoing - just update it
                console.log(`⏸️ Trip ongoing - updating with new data (idle: ${idleMinutes.toFixed(1)} min)`);
                await this.updateOngoingTrip(
                    currentTrip,
                    lastLoc,
                    newWaypoints,
                    newLocationIds
                );
                tripsProcessed++;
            }
        }

        return tripsProcessed;
    }

    // ======================================================
    // 🆕 CREATE NEW TRIP
    // ======================================================
    static async createNewTrip(vehicleId, macIdGps, startLocation) {
        try {
            const startAddress = await GeocodingService.getAddress(
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

            console.log(`✅ Created new trip (ID: ${trip.id})`);

            return {
                id: trip.id,
                vehicle_id: vehicleId,
                mac_id_gps: macIdGps,
                start_time: startLocation.sys_time,
                end_time: startLocation.sys_time,
                status: 'ongoing',
                currentWaypointCount: 0
            };

        } catch (err) {
            console.error("❌ Error creating trip:", err);
            return null;
        }
    }

    // ======================================================
    // 📊 UPDATE ONGOING TRIP
    // ======================================================
    static async updateOngoingTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const trx = await sequelize.transaction();

        try {
            // Add new waypoints
            if (newWaypoints.length > 0) {
                await TripWaypoint.bulkCreate(
                    newWaypoints.map(w => ({ ...w, trip_id: currentTrip.id })),
                    { transaction: trx }
                );
            }

            // Calculate metrics for all waypoints
            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction: trx
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            // Update trip
            await Trip.update({
                end_time: endLocation.sys_time,
                end_latitude: endLocation.latitude,
                end_longitude: endLocation.longitude,
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: metrics.totalDistanceKm,
                avg_speed_kmh: metrics.avgSpeed,
                max_speed_kmh: metrics.maxSpeed,
                waypoint_count: allWaypoints.length
            }, {
                where: { id: currentTrip.id },
                transaction: trx
            });

            // Mark locations as processed
            await Location.update(
                { processed: true, trip_id: currentTrip.id },
                { where: { id: locationIds }, transaction: trx }
            );

            await trx.commit();
            console.log(`✅ Updated ongoing trip (ID: ${currentTrip.id}) with ${newWaypoints.length} new waypoints`);

        } catch (err) {
            await trx.rollback();
            console.error("❌ Error updating ongoing trip:", err);
        }
    }

    // ======================================================
    // 🏁 FINALIZE TRIP
    // ======================================================
    static async finalizeTrip(currentTrip, endLocation, newWaypoints, locationIds) {
        const trx = await sequelize.transaction();

        try {
            // Add new waypoints
            if (newWaypoints.length > 0) {
                await TripWaypoint.bulkCreate(
                    newWaypoints.map(w => ({ ...w, trip_id: currentTrip.id })),
                    { transaction: trx }
                );
            }

            // Get all waypoints for metrics
            const allWaypoints = await TripWaypoint.findAll({
                where: { trip_id: currentTrip.id },
                order: [["sequence_order", "ASC"]],
                raw: true,
                transaction: trx
            });

            const metrics = this.calculateTripMetrics(allWaypoints);

            // Check if trip meets minimum criteria
            if (metrics.durationMinutes < this.MIN_TRIP_DURATION_MIN ||
                metrics.totalDistanceKm < this.MIN_TRIP_DISTANCE_KM) {
                console.log(`⚠️ Trip too short - deleting (${metrics.durationMinutes.toFixed(1)} min, ${metrics.totalDistanceKm.toFixed(2)} km)`);

                // Delete trip and waypoints
                await TripWaypoint.destroy({ where: { trip_id: currentTrip.id }, transaction: trx });
                await Trip.destroy({ where: { id: currentTrip.id }, transaction: trx });

                // Mark locations as processed but with no trip_id
                await Location.update(
                    { processed: true, trip_id: null },
                    { where: { id: locationIds }, transaction: trx }
                );

                await trx.commit();
                return false;
            }

            // Get end address
            const endAddress = await GeocodingService.getAddress(
                endLocation.latitude,
                endLocation.longitude
            );

            // Finalize trip
            await Trip.update({
                end_time: endLocation.sys_time,
                end_latitude: endLocation.latitude,
                end_longitude: endLocation.longitude,
                end_address: endAddress,
                duration_minutes: Math.round(metrics.durationMinutes),
                total_distance_km: metrics.totalDistanceKm,
                avg_speed_kmh: metrics.avgSpeed,
                max_speed_kmh: metrics.maxSpeed,
                waypoint_count: allWaypoints.length,
                status: 'completed'
            }, {
                where: { id: currentTrip.id },
                transaction: trx
            });

            // Mark locations as processed
            await Location.update(
                { processed: true, trip_id: currentTrip.id },
                { where: { id: locationIds }, transaction: trx }
            );

            await trx.commit();
            console.log(`✅ Trip finalized (ID: ${currentTrip.id}): ${metrics.durationMinutes.toFixed(1)} min, ${metrics.totalDistanceKm.toFixed(2)} km`);
            return true;

        } catch (err) {
            await trx.rollback();
            console.error("❌ Error finalizing trip:", err);
            return false;
        }
    }

    // ======================================================
    // 🛠️ HELPER FUNCTIONS
    // ======================================================
    static prepareWaypoint(location, sequenceOrder) {
        return {
            latitude: location.latitude,
            longitude: location.longitude,
            speed: location.speed,
            recorded_at: location.sys_time,
            sequence_order: sequenceOrder
        };
    }

    static calculateTripMetrics(waypoints) {
        let dist = 0;
        let maxSpeed = 0;
        let sumSpeed = 0;
        let cntSpeed = 0;

        for (let i = 1; i < waypoints.length; i++) {
            const a = waypoints[i - 1];
            const b = waypoints[i];

            const d = this._haversineKm(
                Number(a.latitude), Number(a.longitude),
                Number(b.latitude), Number(b.longitude)
            );
            dist += d;

            const s = Number(b.speed || 0);
            if (s > maxSpeed) maxSpeed = s;
            if (s > 0) { sumSpeed += s; cntSpeed++; }
        }

        const start = new Date(waypoints[0].recorded_at);
        const end = new Date(waypoints[waypoints.length - 1].recorded_at);

        return {
            totalDistanceKm: dist,
            durationMinutes: (end - start) / 60000,
            avgSpeed: cntSpeed > 0 ? sumSpeed / cntSpeed : 0,
            maxSpeed
        };
    }

    static _haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;

        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}

module.exports = TripDetectionService;