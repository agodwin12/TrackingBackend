const { Op } = require("sequelize");
const Trip = require("../models/trip");
const TripWaypoint = require("../models/tripWaypoint");
const Voiture = require("../models/voiture");
const redisClient = require("../config/redis");
const logger = require("../utils/logger");

// Cache TTL: 5 minutes - automatically expires and refreshes with fresh data
const TRIP_CACHE_TTL = 300; // 5 minutes (300 seconds)
const EMPTY_RESULT_TTL = 60; // 1 minute for empty results

// 🆕 Waypoint limits for performance
const MAX_WAYPOINTS_FOR_MAP = 200; // Maximum waypoints to send to mobile app
const STATS_TRIP_LIMIT = 1000; // Maximum trips to calculate stats from

/**
 * Get cached data from Redis
 * ✅ Enhanced: Gracefully handles Redis being down
 */
async function getCachedData(key) {
    try {
        // Check if Redis is connected
        if (!redisClient.isConnected) {
            logger.debug('Redis not connected, skipping cache');
            return null;
        }

        const cached = await redisClient.get(key);
        if (cached) {
            logger.debug(`✅ Cache HIT: ${key}`);
            return JSON.parse(cached);
        }
        logger.debug(`❌ Cache MISS: ${key}`);
        return null;
    } catch (error) {
        logger.error(`🔥 Redis GET error for key ${key}:`, error.message);
        return null; // Fail gracefully, fetch from DB
    }
}

/**
 * Set data in Redis cache
 * ✅ Enhanced: Gracefully handles Redis being down
 * Cache automatically expires after TTL - next request will fetch fresh data from database
 */
async function setCachedData(key, data, ttl = TRIP_CACHE_TTL) {
    try {
        // Check if Redis is connected
        if (!redisClient.isConnected) {
            logger.debug('Redis not connected, skipping cache set');
            return;
        }

        await redisClient.setEx(key, ttl, JSON.stringify(data));
        logger.debug(`✅ Cached data: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
        logger.error(`🔥 Redis SET error for key ${key}:`, error.message);
        // Don't throw - caching is optional
    }
}

/**
 * Delete cached data from Redis
 * ✅ Enhanced: Gracefully handles Redis being down
 */
async function deleteCachedData(pattern) {
    try {
        // Check if Redis is connected
        if (!redisClient.isConnected) {
            logger.debug('Redis not connected, skipping cache deletion');
            return;
        }

        if (pattern.includes('*')) {
            // Pattern-based deletion
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(...keys); // ✅ Spread array for multiple keys
                logger.info(`✅ Deleted ${keys.length} cached keys matching: ${pattern}`);
            }
        } else {
            // Single key deletion
            await redisClient.del(pattern);
            logger.debug(`✅ Deleted cached key: ${pattern}`);
        }
    } catch (error) {
        logger.error(`🔥 Redis DELETE error for pattern ${pattern}:`, error.message);
    }
}

/**
 * Format duration minutes to readable string
 */
function formatDuration(minutes) {
    if (!minutes || minutes < 0) return "0 min";
    if (minutes < 60) return `${Math.round(minutes)} min`;

    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);

    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h ${mins}m`;
    }

    return `${hours}h ${mins}m`;
}

/**
 * 🆕 Sample waypoints intelligently to reduce data transfer
 * Always keeps first and last waypoint, samples the middle ones
 */
function sampleWaypoints(waypoints, maxPoints = MAX_WAYPOINTS_FOR_MAP) {
    if (!waypoints || waypoints.length === 0) return [];
    if (waypoints.length <= maxPoints) return waypoints;

    const sampled = [];
    const step = Math.floor(waypoints.length / (maxPoints - 1));

    // Always include first waypoint
    sampled.push(waypoints[0]);

    // Sample middle waypoints
    for (let i = step; i < waypoints.length - 1; i += step) {
        sampled.push(waypoints[i]);
    }

    // Always include last waypoint
    sampled.push(waypoints[waypoints.length - 1]);

    logger.info(`📊 Sampled waypoints: ${waypoints.length} → ${sampled.length}`);
    return sampled;
}

/**
 * Get trips for a specific vehicle
 * GET /api/trips/vehicle/:vehicleId
 */
exports.getVehicleTrips = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        logger.info(`ℹ️ Fetching trips for vehicle: ${vehicleId}`, {
            vehicleId,
            startDate,
            endDate,
            page,
            limit
        });

        // Validate vehicle ID
        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        // Create cache key with all parameters
        const cacheKey = `trips:vehicle:${vehicleId}:page:${page}:limit:${limit}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trips for vehicle ${vehicleId}`);
            return res.json(cachedData);
        }

        // Verify vehicle exists
        const vehicle = await Voiture.findByPk(vehicleId, {
            attributes: ['id'] // Only need ID for existence check
        });

        if (!vehicle) {
            logger.warn(`⚠️ Vehicle not found: ${vehicleId}`);
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        // Build query conditions
        const whereClause = {
            vehicle_id: vehicleId,
            status: 'completed'
        };

        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) {
                whereClause.start_time[Op.gte] = new Date(startDate);
            }
            if (endDate) {
                const endDatePlusOne = new Date(endDate);
                endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
                whereClause.start_time[Op.lt] = endDatePlusOne;
            }
        }

        const offset = (page - 1) * limit;
        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['immatriculation', 'marque', 'model', 'couleur']
            }],
            order: [['start_time', 'DESC']],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        logger.info(`✅ Fetched ${result.rows.length} trips out of ${result.count} total for vehicle ${vehicleId}`);

        // Format trips
        const trips = result.rows.map(t => ({
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
        }));

        const totalPages = Math.ceil(result.count / limit);
        const responseData = {
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
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getVehicleTrips:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch vehicle trips",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * Get trip details by ID
 * GET /api/trips/:tripId
 */
exports.getTripDetails = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`ℹ️ Fetching trip details: ${tripId}`);

        // Validate trip ID
        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:details:${tripId}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trip details for ${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo']
            }]
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        const responseData = {
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
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        logger.info(`✅ Trip details fetched successfully: ${tripId}`);
        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getTripDetails:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch trip details",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * Get trip route (waypoints)
 * GET /api/trips/:tripId/route
 */
exports.getTripRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints } = req.query;

        logger.info(`ℹ️ Fetching trip route: ${tripId}`);

        // Validate trip ID
        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const cacheKey = `trip:route:${tripId}:limit:${limit}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached route for trip ${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            attributes: ['id', 'waypoint_count']
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // Fetch ALL waypoints
        const waypoints = await TripWaypoint.findAll({
            where: { trip_id: tripId },
            order: [['sequence_order', 'ASC']],
            attributes: ['latitude', 'longitude', 'speed', 'recorded_at', 'sequence_order']
        });

        logger.info(`📍 Fetched ${waypoints.length} waypoints for trip ${tripId}`);

        // Sample waypoints if too many
        const sampledWaypoints = sampleWaypoints(waypoints, limit);

        const responseData = {
            success: true,
            data: {
                tripId: parseInt(tripId),
                waypointCount: waypoints.length,
                sampledCount: sampledWaypoints.length,
                isSampled: sampledWaypoints.length < waypoints.length,
                route: sampledWaypoints.map(w => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                })),
                bounds: {
                    start: {
                        latitude: parseFloat(waypoints[0]?.latitude),
                        longitude: parseFloat(waypoints[0]?.longitude)
                    },
                    end: {
                        latitude: parseFloat(waypoints[waypoints.length - 1]?.latitude),
                        longitude: parseFloat(waypoints[waypoints.length - 1]?.longitude)
                    }
                }
            }
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getTripRoute:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch trip route",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * 🆕 OPTIMIZED: Get trip details with sampled route
 * GET /api/trips/:tripId/details-with-route
 */
exports.getTripDetailsWithRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints } = req.query;

        logger.info(`ℹ️ Fetching trip details with route: ${tripId}`);

        // Validate trip ID
        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const cacheKey = `trip:details-route:${tripId}:limit:${limit}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trip details with route for ${tripId}`);
            return res.json(cachedData);
        }

        // Fetch trip details
        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo']
            }]
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
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

        logger.info(`📍 Fetched trip ${tripId} with ${waypoints.length} waypoints`);

        // Sample waypoints for performance
        const sampledWaypoints = sampleWaypoints(waypoints, limit);

        logger.info(`📊 Returning ${sampledWaypoints.length}/${waypoints.length} waypoints`);

        // Format response
        const responseData = {
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
                waypoints: sampledWaypoints.map(w => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed || 0),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                })),
                metadata: {
                    totalWaypoints: waypoints.length,
                    returnedWaypoints: sampledWaypoints.length,
                    isSampled: sampledWaypoints.length < waypoints.length,
                    samplingRatio: waypoints.length > 0
                        ? (sampledWaypoints.length / waypoints.length).toFixed(2)
                        : 1
                }
            }
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getTripDetailsWithRoute:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch trip details with route",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * 🆕 OPTIMIZED: Get vehicle trip statistics
 * GET /api/trips/vehicle/:vehicleId/stats
 */
exports.getVehicleTripStats = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate } = req.query;

        logger.info(`ℹ️ Fetching trip stats for vehicle: ${vehicleId}`, {
            vehicleId,
            startDate,
            endDate
        });

        // Validate vehicle ID
        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        const cacheKey = `trip:stats:${vehicleId}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached stats for vehicle ${vehicleId}`);
            return res.json(cachedData);
        }

        const vehicle = await Voiture.findByPk(vehicleId, {
            attributes: ['id']
        });

        if (!vehicle) {
            logger.warn(`⚠️ Vehicle not found: ${vehicleId}`);
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const whereClause = {
            vehicle_id: vehicleId,
            status: 'completed'
        };

        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) whereClause.start_time[Op.gte] = new Date(startDate);
            if (endDate) {
                const d = new Date(endDate);
                d.setDate(d.getDate() + 1);
                whereClause.start_time[Op.lt] = d;
            }
        }

        // Limit trips to prevent memory issues
        const trips = await Trip.findAll({
            where: whereClause,
            attributes: [
                'total_distance_km',
                'duration_minutes',
                'avg_speed_kmh',
                'max_speed_kmh'
            ],
            limit: STATS_TRIP_LIMIT,
            order: [['start_time', 'DESC']],
            raw: true
        });

        logger.info(`📊 Calculated stats from ${trips.length} trips for vehicle ${vehicleId}`);

        if (!trips.length) {
            const responseData = {
                success: true,
                data: {
                    totalTrips: 0,
                    totalDistanceKm: 0,
                    totalDurationMinutes: 0,
                    avgSpeed: 0,
                    maxSpeed: 0,
                    message: "No trips found for the specified period"
                }
            };

            // Cache empty result with shorter TTL
            await setCachedData(cacheKey, responseData, EMPTY_RESULT_TTL);

            return res.json(responseData);
        }

        const totalTrips = trips.length;
        const totalDistanceKm = trips.reduce((sum, t) => sum + parseFloat(t.total_distance_km || 0), 0);
        const totalDurationMinutes = trips.reduce((sum, t) => sum + parseInt(t.duration_minutes || 0), 0);
        const avgSpeed = trips.reduce((sum, t) => sum + parseFloat(t.avg_speed_kmh || 0), 0) / totalTrips;
        const maxSpeed = Math.max(...trips.map(t => parseFloat(t.max_speed_kmh || 0)));

        const responseData = {
            success: true,
            data: {
                totalTrips,
                totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
                totalDurationMinutes,
                totalDurationFormatted: formatDuration(totalDurationMinutes),
                avgSpeed: parseFloat(avgSpeed.toFixed(2)),
                maxSpeed: parseFloat(maxSpeed.toFixed(2)),
                calculatedFrom: trips.length >= STATS_TRIP_LIMIT
                    ? `Most recent ${STATS_TRIP_LIMIT} trips`
                    : `All ${trips.length} trips`
            }
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getVehicleTripStats:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch trip statistics",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * Get all trips (admin view)
 * GET /api/trips
 */
exports.getAllTrips = async (req, res) => {
    try {
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        logger.info("ℹ️ Fetching all trips", { startDate, endDate, page, limit });

        const cacheKey = `trips:all:page:${page}:limit:${limit}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info('✅ Returning cached trips list');
            return res.json(cachedData);
        }

        const whereClause = { status: 'completed' };

        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) whereClause.start_time[Op.gte] = new Date(startDate);
            if (endDate) {
                const d = new Date(endDate);
                d.setDate(d.getDate() + 1);
                whereClause.start_time[Op.lt] = d;
            }
        }

        const offset = (page - 1) * limit;
        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['immatriculation', 'marque', 'model']
            }],
            order: [['start_time', 'DESC']],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        logger.info(`✅ Fetched ${result.rows.length} trips out of ${result.count} total`);

        const responseData = { success: true, data: result };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getAllTrips:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch trips",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * Delete a trip
 * DELETE /api/trips/:tripId
 */
exports.deleteTrip = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`ℹ️ Deleting trip: ${tripId}`);

        // Validate trip ID
        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            logger.warn(`⚠️ Trip not found for deletion: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        const vehicleId = trip.vehicle_id;

        await trip.destroy();
        logger.info(`✅ Trip deleted successfully: ${tripId}`);

        // Invalidate all related caches
        await deleteCachedData(`trip:details:${tripId}`);
        await deleteCachedData(`trip:route:${tripId}:*`);
        await deleteCachedData(`trip:details-route:${tripId}:*`);
        await deleteCachedData(`trip:full:${tripId}`);
        await deleteCachedData(`trips:vehicle:${vehicleId}:*`);
        await deleteCachedData(`trip:stats:${vehicleId}:*`);
        await deleteCachedData(`trips:all:*`);

        logger.info(`✅ Cleared all related caches for trip ${tripId}`);

        res.json({
            success: true,
            message: "Trip deleted successfully"
        });

    } catch (error) {
        logger.error("🔥 Error in deleteTrip:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete trip",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

/**
 * Get trip details with full route (legacy endpoint)
 * GET /api/trips/:tripId/full
 * ⚠️ Returns ALL waypoints - use /details-with-route for mobile apps
 */
exports.getTripFull = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`ℹ️ Fetching FULL trip details (all waypoints): ${tripId}`);

        // Validate trip ID
        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:full:${tripId}`;

        // Try to get from cache
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached full trip for ${tripId}`);
            return res.json(cachedData);
        }

        // Fetch trip details
        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo']
            }]
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // Fetch ALL waypoints (no sampling)
        const waypoints = await TripWaypoint.findAll({
            where: { trip_id: tripId },
            order: [['sequence_order', 'ASC']],
            attributes: ['latitude', 'longitude', 'speed', 'recorded_at', 'sequence_order']
        });

        logger.info(`📍 Fetched trip ${tripId} with ${waypoints.length} waypoints (FULL)`);

        // Format response
        const responseData = {
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
        };

        // Cache the response
        await setCachedData(cacheKey, responseData);

        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getTripFull:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch full trip details",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

module.exports = exports;