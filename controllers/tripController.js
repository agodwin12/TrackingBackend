const { Op } = require("sequelize");
const Trip = require("../models/Trip");
const TripWaypoint = require("../models/TripWaypoint");
const Voiture = require("../models/Voiture");

exports.getVehicleTrips = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        console.log("\n📌 [getVehicleTrips] Endpoint hit");
        console.log("➡ Params:", req.params);
        console.log("➡ Query:", req.query);

        const vehicle = await Voiture.findByPk(vehicleId);
        console.log("🔍 Vehicle lookup result:", vehicle ? "✅ Found" : "⛔ Not found");

        if (!vehicle) {
            return res.status(404).json({ success: false, message: "Vehicle not found" });
        }

        const whereClause = { vehicle_id: vehicleId };
        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) {
                console.log("📅 Filtering from:", startDate);
                whereClause.start_time[Op.gte] = new Date(startDate);
            }
            if (endDate) {
                console.log("📅 Filtering to:", endDate);
                const endDatePlusOne = new Date(endDate);
                endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
                whereClause.start_time[Op.lt] = endDatePlusOne;
            }
        }

        console.log("🔎 Query where clause:", whereClause);

        const offset = (page - 1) * limit;
        console.log("📌 Pagination => Offset:", offset, "Limit:", limit);

        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{ model: Voiture, as: 'vehicle', attributes: ['immatriculation', 'marque', 'model', 'couleur'] }],
            order: [['start_time', 'DESC']],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        console.log("📊 Trips fetched:", result.count);

        const trips = result.rows.map(t => {
            console.log("➡ Processing trip:", t.id);
            return {
                id: t.id,
                vehicleId: t.vehicle_id,
                vehicleInfo: {
                    immatriculation: t.vehicle.immatriculation,
                    marque: t.vehicle.marque,
                    model: t.vehicle.model,
                    couleur: t.vehicle.couleur
                },
                startTime: t.start_time,
                endTime: t.end_time,
                durationMinutes: t.duration_minutes,
                durationFormatted: formatDuration(t.duration_minutes),
                startLocation: {
                    latitude: parseFloat(t.start_latitude),
                    longitude: parseFloat(t.start_longitude),
                    address: t.start_address
                },
                endLocation: {
                    latitude: parseFloat(t.end_latitude),
                    longitude: parseFloat(t.end_longitude),
                    address: t.end_address
                },
                totalDistanceKm: parseFloat(t.total_distance_km),
                avgSpeedKmh: parseFloat(t.avg_speed_kmh),
                maxSpeedKmh: parseFloat(t.max_speed_kmh),
                waypointCount: t.waypoint_count,
                createdAt: t.created_at
            };
        });

        const totalPages = Math.ceil(result.count / limit);
        console.log("📄 Pagination => Total Pages:", totalPages);

        res.json({
            success: true,
            data: {
                trips,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages,
                    totalTrips: result.count,
                    tripsPerPage: parseInt(limit),
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getVehicleTrips:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.getTripDetails = async (req, res) => {
    try {
        console.log("\n📌 [getTripDetails] Endpoint hit", req.params);

        const trip = await Trip.findByPk(req.params.tripId, {
            include: [
                { model: Voiture, as: 'vehicle', attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo'] }
            ]
        });

        console.log("🔍 Trip lookup result:", trip ? "✅ Found" : "⛔ Not found");

        if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });

        res.json({
            success: true,
            data: {
                id: trip.id,
                vehicleId: trip.vehicle_id,
                vehicleInfo: trip.vehicle,
                startTime: trip.start_time,
                endTime: trip.end_time,
                durationMinutes: trip.duration_minutes,
                durationFormatted: formatDuration(trip.duration_minutes),
                startLocation: {
                    latitude: parseFloat(trip.start_latitude),
                    longitude: parseFloat(trip.start_longitude),
                    address: trip.start_address
                },
                endLocation: {
                    latitude: parseFloat(trip.end_latitude),
                    longitude: parseFloat(trip.end_longitude),
                    address: trip.end_address
                },
                totalDistanceKm: parseFloat(trip.total_distance_km),
                avgSpeedKmh: parseFloat(trip.avg_speed_kmh),
                maxSpeedKmh: parseFloat(trip.max_speed_kmh),
                waypointCount: trip.waypoint_count,
                createdAt: trip.created_at
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getTripDetails:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.getTripRoute = async (req, res) => {
    try {
        console.log("\n📌 [getTripRoute] Trip ID:", req.params.tripId);

        const trip = await Trip.findByPk(req.params.tripId);
        console.log("🔍 Trip exists:", !!trip);

        if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });

        const waypoints = await TripWaypoint.findAll({
            where: { trip_id: req.params.tripId },
            order: [['sequence_order', 'ASC']],
            attributes: ['latitude', 'longitude', 'speed', 'recorded_at', 'sequence_order']
        });

        console.log("📊 Waypoints count:", waypoints.length);

        res.json({
            success: true,
            data: {
                tripId: parseInt(req.params.tripId),
                waypointCount: waypoints.length,
                route: waypoints.map((w, i) => {
                    console.log(`➡ Waypoint ${i + 1}`, w.latitude, w.longitude);
                    return {
                        latitude: parseFloat(w.latitude),
                        longitude: parseFloat(w.longitude),
                        speed: parseFloat(w.speed),
                        timestamp: w.recorded_at,
                        order: w.sequence_order
                    };
                }),
                bounds: {
                    start: {
                        latitude: parseFloat(waypoints[0]?.latitude),
                        longitude: parseFloat(waypoints[0]?.longitude)
                    },
                    end: {
                        latitude: parseFloat(waypoints.at(-1)?.latitude),
                        longitude: parseFloat(waypoints.at(-1)?.longitude)
                    }
                }
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getTripRoute:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.getVehicleTripStats = async (req, res) => {
    try {
        console.log("\n📌 [getVehicleTripStats] Request", req.params, req.query);

        const vehicle = await Voiture.findByPk(req.params.vehicleId);
        console.log("🔍 Vehicle exists:", !!vehicle);

        if (!vehicle) return res.status(404).json({ success: false, message: "Vehicle not found" });

        const whereClause = { vehicle_id: req.params.vehicleId };
        if (req.query.startDate || req.query.endDate) {
            whereClause.start_time = {};
            if (req.query.startDate) whereClause.start_time[Op.gte] = new Date(req.query.startDate);
            if (req.query.endDate) {
                const d = new Date(req.query.endDate);
                d.setDate(d.getDate() + 1);
                whereClause.start_time[Op.lt] = d;
            }
        }

        console.log("🔎 Condition:", whereClause);

        const trips = await Trip.findAll({ where: whereClause, raw: true });
        console.log("📊 Number of trips:", trips.length);

        if (!trips.length) {
            return res.json({
                success: true,
                data: {
                    totalTrips: 0,
                    totalDistanceKm: 0,
                    totalDurationMinutes: 0,
                    message: "No trips found for the specified period"
                }
            });
        }

        const totalTrips = trips.length;
        const totalDistanceKm = trips.reduce((s, t) => s + parseFloat(t.total_distance_km), 0);

        const totalDurationMinutes = trips.reduce((s, t) => s + parseInt(t.duration_minutes), 0);
        const avgSpeed = trips.reduce((s, t) => s + parseFloat(t.avg_speed_kmh), 0) / totalTrips;
        const maxSpeed = Math.max(...trips.map(t => parseFloat(t.max_speed_kmh)));

        console.log("✅ Stats calculated:", { totalTrips, totalDistanceKm, maxSpeed });

        res.json({
            success: true,
            data: {
                totalTrips,
                totalDistanceKm,
                totalDurationMinutes,
                avgSpeed,
                maxSpeed
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getVehicleTripStats:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.getAllTrips = async (req, res) => {
    try {
        console.log("\n📌 [getAllTrips] Filters:", req.query);

        const whereClause = {};
        if (req.query.startDate || req.query.endDate) {
            whereClause.start_time = {};
            if (req.query.startDate) whereClause.start_time[Op.gte] = new Date(req.query.startDate);
            if (req.query.endDate) {
                const d = new Date(req.query.endDate);
                d.setDate(d.getDate() + 1);
                whereClause.start_time[Op.lt] = d;
            }
        }
        console.log("🔎 Where:", whereClause);

        const offset = (req.query.page - 1) * req.query.limit;

        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{ model: Voiture, as: 'vehicle', attributes: ['immatriculation', 'marque', 'model'] }],
            order: [['start_time', 'DESC']],
            limit: parseInt(req.query.limit),
            offset: parseInt(offset)
        });

        console.log("📊 Total trips:", result.count);

        res.json({ success: true, data: result });

    } catch (error) {
        console.error("🔥 ERROR in getAllTrips:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.deleteTrip = async (req, res) => {
    try {
        console.log("\n🗑️ [deleteTrip] ID:", req.params.tripId);

        const trip = await Trip.findByPk(req.params.tripId);
        console.log("🔍 Trip exists:", !!trip);

        if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });

        await trip.destroy();
        console.log("✅ Trip deleted");

        res.json({ success: true, message: "Trip deleted successfully" });

    } catch (error) {
        console.error("🔥 ERROR in deleteTrip:", error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};

exports.getTripDetailsWithRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        console.log("\n📌 [getTripDetailsWithRoute] Trip ID:", tripId);

        // Fetch trip details
        const trip = await Trip.findByPk(tripId, {
            include: [
                {
                    model: Voiture,
                    as: 'vehicle',
                    attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo']
                }
            ]
        });

        console.log("🔍 Trip lookup result:", trip ? "✅ Found" : "⛔ Not found");

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // Fetch waypoints
        const waypoints = await TripWaypoint.findAll({
            where: { trip_id: tripId },
            order: [['sequence_order', 'ASC']],
            attributes: ['latitude', 'longitude', 'speed', 'recorded_at', 'sequence_order']
        });

        console.log("📊 Waypoints count:", waypoints.length);

        // Format response
        res.json({
            success: true,
            data: {
                trip: {
                    id: trip.id,
                    vehicleId: trip.vehicle_id,
                    vehicleInfo: trip.vehicle,
                    startTime: trip.start_time,
                    endTime: trip.end_time,
                    durationMinutes: trip.duration_minutes,
                    durationFormatted: formatDuration(trip.duration_minutes),
                    startLocation: {
                        latitude: parseFloat(trip.start_latitude),
                        longitude: parseFloat(trip.start_longitude),
                        address: trip.start_address
                    },
                    endLocation: {
                        latitude: parseFloat(trip.end_latitude),
                        longitude: parseFloat(trip.end_longitude),
                        address: trip.end_address
                    },
                    totalDistanceKm: parseFloat(trip.total_distance_km),
                    avgSpeedKmh: parseFloat(trip.avg_speed_kmh),
                    maxSpeedKmh: parseFloat(trip.max_speed_kmh),
                    waypointCount: trip.waypoint_count,
                    createdAt: trip.created_at
                },
                waypoints: waypoints.map(w => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed || 0),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                }))
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getTripDetailsWithRoute:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};


function formatDuration(minutes) {
    console.log("⏱️ Formatting duration:", minutes);
    if (minutes < 60) return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h ${mins}m`;
    }
    return `${hours}h ${mins}m`;
}
