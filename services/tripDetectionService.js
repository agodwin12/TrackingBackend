const { Op } = require("sequelize");
const Location = require("../models/location");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const GeocodingService = require("./GeocodingService");
const sequelize = require("../config/database");

class TripDetectionService {
    // ---- SETTINGS ----
    static IDLE_THRESHOLD_MINUTES = Number(process.env.TRIP_IDLE_MINUTES ?? 10); // ✅ Changed from 2 to 10 minutes
    static END_GAP_MINUTES = Number(process.env.TRIP_END_GAP_MIN ?? 5);
    static MIN_SPEED_THRESHOLD = Number(process.env.TRIP_MIN_SPEED_KMH ?? 1);
    static MIN_TRIP_DURATION_MIN = Number(process.env.TRIP_MIN_DURATION ?? 1);
    static MIN_TRIP_DISTANCE_KM = Number(process.env.TRIP_MIN_DISTANCE_KM ?? 0.2);

    // ======================================================
    // 🔍 Get vehicles with unprocessed location data
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
        console.log(`Trips Created: ${totalTrips}`);
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

        // ======================================================
        // 🆕 FETCH USER USING association_user_voitures
        // ======================================================
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
        console.log(`👤 Vehicle belongs to User ID: ${userId}`);

        // Fetch user preferences
        const user = await User.findByPk(userId, {
            attributes: ["id", "nom", "prenom", "email", "trip_tracking_enabled"],
            raw: true
        });

        if (!user) {
            console.log("⚠️ User not found → Mark processed");
            await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps } });
            return { skipped: false, tripsCreated: 0 };
        }

        if (!user.trip_tracking_enabled) {
            console.log("🚫 Trip tracking disabled → Skipping");
            await Location.update({ processed: true }, { where: { mac_id_gps: macIdGps } });
            return { skipped: true, tripsCreated: 0 };
        }

        console.log("✅ Trip tracking ENABLED - Processing trips...");

        const trips = this.detectTripsFromLocations(locations, vehicle.id, macIdGps);

        let saved = 0;
        for (const t of trips) {
            if (await this.saveTripToDatabase(t)) saved++;
        }

        return { skipped: false, tripsCreated: saved };
    }

    // ======================================================
    // 🧠 TRIP DETECTION ALGORITHM
    // ======================================================
    static detectTripsFromLocations(locations, vehicleId, macIdGps) {
        const trips = [];
        let inTrip = false;
        let current = null;
        let lastMove = null;

        console.log(`🔍 Analyzing ${locations.length} location points with ${this.IDLE_THRESHOLD_MINUTES} min idle threshold...`);

        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];
            const speed = Number(loc.speed || 0);
            const moving = speed >= this.MIN_SPEED_THRESHOLD;

            if (!inTrip && moving) {
                // ✅ Start a new trip
                inTrip = true;
                current = {
                    vehicleId,
                    macIdGps,
                    startLocation: loc,
                    endLocation: loc,
                    waypoints: [loc],
                    locationIds: [loc.id],
                    startTime: new Date(loc.sys_time),
                    lastPointTime: new Date(loc.sys_time)
                };
                lastMove = loc;
                console.log(`🚀 Trip started at ${loc.sys_time}`);
                continue;
            }

            if (inTrip) {
                current.endLocation = loc;
                current.waypoints.push(loc);
                current.locationIds.push(loc.id);

                if (moving) {
                    // Vehicle is still moving
                    lastMove = loc;
                } else {
                    // ✅ Vehicle stopped - check idle time
                    const idleMin = (new Date(loc.sys_time) - new Date(lastMove.sys_time)) / 60000;

                    if (idleMin >= this.IDLE_THRESHOLD_MINUTES) {
                        // ✅ Vehicle has been stopped for 10+ minutes → End trip
                        console.log(`🛑 Trip ended after ${idleMin.toFixed(1)} min idle at ${loc.sys_time}`);
                        trips.push(current);
                        inTrip = false;
                        current = null;
                        lastMove = null;
                    } else {
                        // Still within idle threshold - continue trip
                        console.log(`⏳ Vehicle idle for ${idleMin.toFixed(1)} min (threshold: ${this.IDLE_THRESHOLD_MINUTES} min)`);
                    }
                }
            }
        }

        // Flush last trip if still in progress
        if (inTrip && current) {
            console.log(`🏁 Final trip flushed (still in progress)`);
            trips.push(current);
        }

        console.log(`✅ Detected ${trips.length} trip(s)`);
        return trips;
    }

    // ======================================================
    // 💾 SAVE TRIP + WAYPOINTS
    // ======================================================
    static async saveTripToDatabase(t) {
        const trx = await sequelize.transaction();
        try {
            const metrics = this.calculateTripMetrics(t.waypoints);

            console.log(`📊 Trip Metrics: ${metrics.durationMinutes.toFixed(1)} min, ${metrics.totalDistanceKm.toFixed(2)} km`);

            if (metrics.durationMinutes < this.MIN_TRIP_DURATION_MIN ||
                metrics.totalDistanceKm < this.MIN_TRIP_DISTANCE_KM) {
                console.log(`⚠️ Trip too short - skipped (min: ${this.MIN_TRIP_DURATION_MIN} min, ${this.MIN_TRIP_DISTANCE_KM} km)`);
                await trx.rollback();
                return false;
            }

            const startAddress = await GeocodingService.getAddress(
                t.startLocation.latitude, t.startLocation.longitude
            );

            const endAddress = await GeocodingService.getAddress(
                t.endLocation.latitude, t.endLocation.longitude
            );

            const trip = await Trip.create({
                vehicle_id: t.vehicleId,
                mac_id_gps: t.macIdGps,
                start_time: t.startLocation.sys_time,
                end_time: t.endLocation.sys_time,
                duration_minutes: Math.round(metrics.durationMinutes),
                start_latitude: t.startLocation.latitude,
                start_longitude: t.startLocation.longitude,
                start_address: startAddress,
                end_latitude: t.endLocation.latitude,
                end_longitude: t.endLocation.longitude,
                end_address: endAddress,
                total_distance_km: metrics.totalDistanceKm,
                avg_speed_kmh: metrics.avgSpeed,
                max_speed_kmh: metrics.maxSpeed,
                waypoint_count: t.waypoints.length
            }, { transaction: trx });

            const waypoints = t.waypoints.map((w, i) => ({
                trip_id: trip.id,
                latitude: w.latitude,
                longitude: w.longitude,
                speed: w.speed,
                recorded_at: w.sys_time,
                sequence_order: i + 1
            }));

            await TripWaypoint.bulkCreate(waypoints, { transaction: trx });

            await Location.update(
                { processed: true, trip_id: trip.id },
                { where: { id: t.locationIds }, transaction: trx }
            );

            await trx.commit();
            console.log(`✅ Trip saved: ID ${trip.id}`);
            return true;

        } catch (err) {
            await trx.rollback();
            console.error("❌ Save trip error:", err);
            return false;
        }
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

        const start = new Date(waypoints[0].sys_time);
        const end = new Date(waypoints.at(-1).sys_time);

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