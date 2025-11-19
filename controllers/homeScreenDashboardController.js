// controllers/homeScreenDashboardController.js
const Voiture = require("../models/voiture");
const Location = require("../models/location");
const VehicleSecurity = require("../models/vehicleSecurity");
const Trip = require("../models/trip");
const { Alert } = require("../models");
const { Op } = require("sequelize");
const cacheService = require("../services/cacheService");


exports.getCompleteDashboard = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { userId } = req.query; // Pass userId in query string

        console.log(`\n🏠 ========== DASHBOARD REQUEST ==========`);
        console.log(`🏠 Vehicle ID: ${vehicleId}`);
        console.log(`👤 User ID: ${userId}`);

        // Validate inputs
        if (!vehicleId || !userId) {
            return res.status(400).json({
                success: false,
                message: "vehicleId and userId are required"
            });
        }

        // ✅ Step 1: Get User's Vehicles (LONG CACHE - 1 hour)
        console.log(`\n📋 Fetching user vehicles...`);
        const vehicles = await cacheService.getOrFetch(
            `user:${userId}:vehicles`,
            async () => {
                const AssociationUserVoiture = require("../models/AssociationUserVoiture");

                const associations = await AssociationUserVoiture.findAll({
                    where: { user_id: userId },
                    attributes: ["voiture_id"],
                });

                if (associations.length === 0) {
                    return [];
                }

                const voitureIds = associations.map(a => a.voiture_id);
                const voitures = await Voiture.findAll({
                    where: { id: voitureIds },
                    attributes: ["id", "model", "immatriculation", "couleur", "photo"],
                });

                console.log(`✅ Found ${voitures.length} vehicles`);
                return voitures;
            },
            3600 // 1 hour cache
        );

        // ✅ Step 2: Get Vehicle Details (MEDIUM CACHE - 5 minutes)
        console.log(`\n🚗 Fetching vehicle details...`);
        const vehicleDetails = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:details`,
            async () => {
                const vehicle = await Voiture.findOne({
                    where: { id: vehicleId },
                    attributes: ["id", "mac_id_gps", "model", "immatriculation", "couleur"],
                });

                if (!vehicle) {
                    throw new Error("Vehicle not found");
                }

                console.log(`✅ Vehicle: ${vehicle.model}`);
                return vehicle;
            },
            300 // 5 minutes cache
        );

        // ✅ Step 3: Get Current Location with Address (SHORT CACHE - 30s)
        console.log(`\n📍 Fetching current location...`);
        const location = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:location:address`,
            async () => {
                const latestLocation = await Location.findOne({
                    where: { mac_id_gps: vehicleDetails.mac_id_gps },
                    order: [["sys_time", "DESC"]],
                    attributes: ["latitude", "longitude", "speed", "sys_time"],
                });

                if (!latestLocation) {
                    return {
                        latitude: null,
                        longitude: null,
                        address: "Location not available",
                        speed: 0,
                        updated_at: null
                    };
                }

                // Simple address formatting (you can enhance this with reverse geocoding)
                const address = `Lat: ${latestLocation.latitude}, Lng: ${latestLocation.longitude}`;

                console.log(`✅ Location updated`);
                return {
                    latitude: parseFloat(latestLocation.latitude),
                    longitude: parseFloat(latestLocation.longitude),
                    address: address,
                    speed: parseFloat(latestLocation.speed || 0),
                    updated_at: latestLocation.sys_time
                };
            },
            30 // 30 seconds cache
        );

        // ✅ Step 4: Get Real-Time Data (NO CACHE - always fresh)
        // Note: This should eventually move to Socket.IO
        console.log(`\n⚡ Fetching real-time data...`);
        const realtimeData = await Location.findOne({
            where: { mac_id_gps: vehicleDetails.mac_id_gps },
            order: [["sys_time", "DESC"]],
            attributes: ["speed", "status"],
        });

        let gpsStatus = "Disconnected";
        let vehicleStatus = "Inactive";
        let currentSpeed = "0";

        if (realtimeData) {
            if (realtimeData.status && /1/.test(realtimeData.status)) {
                gpsStatus = "Connected";
                vehicleStatus = "Active";
            }
            currentSpeed = realtimeData.speed || "0";
        }

        console.log(`✅ Real-time: Speed=${currentSpeed}, GPS=${gpsStatus}`);

        // ✅ Step 5: Get Security Status (SHORT CACHE - 30s)
        console.log(`\n🔐 Fetching security status...`);
        const security = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:security`,
            async () => {
                const sec = await VehicleSecurity.findOne({
                    where: { voiture_id: vehicleId }
                });

                console.log(`✅ Security: ${sec?.is_active ? 'ON' : 'OFF'}`);
                return sec ? sec : { is_active: false, voiture_id: vehicleId };
            },
            30 // 30 seconds cache
        );

        // ✅ Step 6: Get Weekly Statistics (MEDIUM CACHE - 5 minutes)
        console.log(`\n📊 Fetching weekly statistics...`);
        const weeklyStats = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:stats:weekly`,
            async () => {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 7);

                const whereClause = {
                    vehicle_id: vehicleId,
                    start_time: {
                        [Op.gte]: startDate,
                        [Op.lt]: endDate
                    }
                };

                const trips = await Trip.findAll({ where: whereClause, raw: true });

                if (!trips.length) {
                    console.log(`⚠️ No trips found for weekly stats`);
                    return {
                        totalTrips: 0,
                        totalDistanceKm: 0,
                        totalDurationMinutes: 0,
                        totalDurationFormatted: "0h 0m",
                        avgSpeed: 0,
                        maxSpeed: 0
                    };
                }

                const totalTrips = trips.length;
                const totalDistanceKm = trips.reduce((s, t) => s + parseFloat(t.total_distance_km || 0), 0);
                const totalDurationMinutes = trips.reduce((s, t) => s + parseInt(t.duration_minutes || 0), 0);
                const avgSpeed = trips.reduce((s, t) => s + parseFloat(t.avg_speed_kmh || 0), 0) / totalTrips;
                const maxSpeed = Math.max(...trips.map(t => parseFloat(t.max_speed_kmh || 0)));

                console.log(`✅ Stats: ${totalTrips} trips, ${totalDistanceKm.toFixed(1)}km`);

                return {
                    totalTrips,
                    totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
                    totalDurationMinutes,
                    totalDurationFormatted: formatDuration(totalDurationMinutes),
                    avgSpeed: parseFloat(avgSpeed.toFixed(1)),
                    maxSpeed: parseFloat(maxSpeed.toFixed(1))
                };
            },
            300 // 5 minutes cache
        );

        // ✅ Step 7: Get Recent Trips (MEDIUM CACHE - 5 minutes)
        console.log(`\n🚗 Fetching recent trips...`);
        const recentTrips = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:trips:recent`,
            async () => {
                const trips = await Trip.findAll({
                    where: { vehicle_id: vehicleId },
                    order: [['start_time', 'DESC']],
                    limit: 5,
                    attributes: [
                        'id', 'start_time', 'end_time', 'start_address',
                        'end_address', 'total_distance_km', 'duration_minutes'
                    ]
                });

                console.log(`✅ Found ${trips.length} recent trips`);

                return trips.map(trip => ({
                    id: trip.id,
                    startTime: trip.start_time,
                    endTime: trip.end_time,
                    from: trip.start_address?.split(',')[0] || "Unknown",
                    to: trip.end_address?.split(',')[0] || "Unknown",
                    distance: `${trip.total_distance_km} km`,
                    duration: formatDuration(trip.duration_minutes)
                }));
            },
            300 // 5 minutes cache
        );

        // ✅ Step 8: Get Unread Notifications (SHORT CACHE - 1 minute)
        console.log(`\n🔔 Fetching notifications...`);
        const notifications = await cacheService.getOrFetch(
            `vehicle:${vehicleId}:notifications:unread`,
            async () => {
                const count = await Alert.count({
                    where: {
                        voiture_id: vehicleId,
                        read: false
                    }
                });

                console.log(`✅ Unread notifications: ${count}`);
                return { unreadCount: count };
            },
            60 // 1 minute cache
        );

        // ✅ Build Complete Response
        console.log(`\n✅ ========== DASHBOARD COMPLETE ==========\n`);

        res.json({
            success: true,
            data: {
                // Real-time data (will move to WebSocket later)
                realtime: {
                    vehicleStatus,
                    gpsStatus,
                    currentSpeed
                },

                // User's vehicles
                vehicles,

                // Selected vehicle details
                vehicleDetails: {
                    id: vehicleDetails.id,
                    model: vehicleDetails.model,
                    plate: vehicleDetails.immatriculation,
                    color: vehicleDetails.couleur
                },

                // Current location
                location,

                // Security status
                security: {
                    isActive: security.is_active || false
                },

                // Weekly statistics
                weeklyStats,

                // Recent trips
                recentTrips,

                // Notifications
                notifications
            }
        });

    } catch (error) {
        console.error(`\n🔥 ========== DASHBOARD ERROR ==========`);
        console.error("🔥 Error:", error.message);
        console.error("🔥 Stack:", error.stack);
        console.log(`========== ERROR END ==========\n`);

        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};


function formatDuration(minutes) {
    if (!minutes || minutes < 1) return "0m";
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h ${mins}m`;
    }

    return `${hours}h ${mins}m`;
}