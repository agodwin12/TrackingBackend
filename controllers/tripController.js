// controllers/tripController.js - CLEAN LARAVEL-STYLE (WORKING)
const { Op } = require("sequelize");
const Trip = require("../models/trip");
const Location = require("../models/location");
const Voiture = require("../models/voiture");
const redisClient = require("../config/redis");
const logger = require("../utils/logger");
const axios = require("axios");

// Cache TTL: 5 minutes
const TRIP_CACHE_TTL = 300;
const EMPTY_RESULT_TTL = 60;

// Limits (matching Laravel)
const MAX_WAYPOINTS_FOR_MAP = 1500;
const MAX_WAYPOINTS_FOR_FOCUS = 20000;
const MAX_DB_ROWS = 20000;
const MAX_DB_ROWS_FOCUS = 120000;
const STATS_TRIP_LIMIT = 1000;

// ==================== ADDRESS HANDLING ====================

/**
 * Smart address formatter with city fallback
 * Priority: Street > City > Coordinates
 */
function formatAddress(address, addressStatus, latitude, longitude) {
    // If we have a good geocoded address
    if (addressStatus === 'geocoded' && address &&
        address !== 'Unknown location' &&
        address !== 'Geocoding...' &&
        !address.includes('°')) {
        return address;
    }

    // If geocoding is pending
    if (addressStatus === 'pending') {
        return 'Geocoding...';
    }

    // Fallback to coordinates
    if (latitude && longitude) {
        return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
    }

    return 'Unknown location';
}

/**
 * Extract city name from full address
 * Examples:
 * "Avenue de la Liberation, Douala, Cameroon" => "Douala"
 * "123 Main St, Yaounde" => "Yaounde"
 */
function extractCityFromAddress(fullAddress) {
    if (!fullAddress || fullAddress.includes('°')) return null;

    const parts = fullAddress.split(',').map(p => p.trim());

    // Usually city is second-to-last or last part
    if (parts.length >= 2) {
        // Try second-to-last (usually city before country)
        const cityCandidate = parts[parts.length - 2];
        if (cityCandidate && cityCandidate.length > 2 && !cityCandidate.match(/^\d/)) {
            return cityCandidate;
        }
    }

    if (parts.length >= 1) {
        // Fallback to last part
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.length > 2 && !lastPart.match(/^\d/)) {
            return lastPart;
        }
    }

    return null;
}

// ==================== CACHE FUNCTIONS ====================
async function getCachedData(key) {
    try {
        if (!redisClient.isConnected) return null;
        const cached = await redisClient.get(key);
        if (cached) {
            logger.debug(`✅ Cache HIT: ${key}`);
            return JSON.parse(cached);
        }
        return null;
    } catch (error) {
        logger.error(`🔥 Redis GET error: ${error.message}`);
        return null;
    }
}

async function setCachedData(key, data, ttl = TRIP_CACHE_TTL) {
    try {
        if (!redisClient.isConnected) return;
        await redisClient.setEx(key, ttl, JSON.stringify(data));
        logger.debug(`✅ Cached: ${key}`);
    } catch (error) {
        logger.error(`🔥 Redis SET error: ${error.message}`);
    }
}

async function deleteCachedData(pattern) {
    try {
        if (!redisClient.isConnected) return;
        if (pattern.includes('*')) {
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(...keys);
                logger.info(`✅ Deleted ${keys.length} cached keys`);
            }
        } else {
            await redisClient.del(pattern);
        }
    } catch (error) {
        logger.error(`🔥 Redis DELETE error: ${error.message}`);
    }
}

// ==================== UTILITY FUNCTIONS ====================
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

// ==================== LARAVEL-STYLE GPS TRACK BUILDING ====================

/**
 * ✅ CLEAN LARAVEL APPROACH: Simple, works perfectly
 * - Fetches raw GPS from locations table
 * - Only removes consecutive duplicates
 * - Simple step-based sampling
 * - NO aggressive filtering
 */
async function fetchWaypointsFromLocations(trip, maxPoints = MAX_WAYPOINTS_FOR_MAP, maxDbRows = MAX_DB_ROWS) {
    try {
        const mac = trip.mac_id_gps || trip.vehicle?.mac_id_gps;
        if (!mac) {
            logger.warn(`⚠️ Trip ${trip.id} has no mac_id_gps`);
            return [];
        }

        // ±2 minute buffer (Laravel style)
        const startTime = new Date(trip.start_time);
        const endTime = trip.end_time ? new Date(trip.end_time) : new Date(startTime.getTime() + 3 * 60 * 60 * 1000);

        const startQuery = new Date(startTime.getTime() - 2 * 60 * 1000);
        const endQuery = new Date(endTime.getTime() + 2 * 60 * 1000);

        logger.debug(`📍 Fetching locations for trip ${trip.id}`);

        // Fetch raw locations (Laravel equivalent)
        const locations = await Location.findAll({
            where: {
                mac_id_gps: mac,
                sys_time: {
                    [Op.between]: [startQuery, endQuery]
                },
                latitude: {
                    [Op.ne]: null,
                    [Op.ne]: 0
                },
                longitude: {
                    [Op.ne]: null,
                    [Op.ne]: 0
                }
            },
            attributes: ['latitude', 'longitude', 'sys_time', 'speed'],
            order: [['sys_time', 'ASC']],
            limit: maxDbRows,
            raw: true
        });

        logger.info(`📍 Found ${locations.length} raw GPS points for trip ${trip.id}`);

        if (locations.length === 0) {
            return [];
        }

        // ✅ SIMPLE DEDUPLICATION (Laravel style - only consecutive duplicates)
        const points = [];
        let prevKey = null;

        for (const loc of locations) {
            const lat = parseFloat(loc.latitude);
            const lng = parseFloat(loc.longitude);

            // Validate coordinates
            if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                continue;
            }

            // Create key with 6 decimal precision
            const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;

            // Skip only if EXACTLY the same as previous point
            if (key === prevKey) continue;
            prevKey = key;

            points.push({
                latitude: lat,
                longitude: lng,
                speed: parseFloat(loc.speed || 0),
                recorded_at: loc.sys_time
            });
        }

        logger.info(`📍 After deduplication: ${locations.length} → ${points.length} points`);

        // ✅ SIMPLE SAMPLING (Laravel style - step-based)
        let finalPoints = points;

        if (points.length > maxPoints) {
            const step = Math.ceil(points.length / maxPoints);
            const reduced = [];

            // Sample with step
            for (let i = 0; i < points.length; i += step) {
                reduced.push(points[i]);
            }

            // Always include last point
            const lastPoint = points[points.length - 1];
            if (reduced.length === 0 || reduced[reduced.length - 1] !== lastPoint) {
                reduced.push(lastPoint);
            }

            finalPoints = reduced;
            logger.info(`📊 Sampled: ${points.length} → ${finalPoints.length} points (step=${step})`);
        }

        // Add sequence order
        return finalPoints.map((point, index) => ({
            ...point,
            sequence_order: index + 1
        }));

    } catch (error) {
        logger.error(`🔥 Error fetching waypoints for trip ${trip.id}:`, error);
        return [];
    }
}

// ==================== OSRM ROAD SNAPPING ====================

/**
 * ✅ Snap GPS waypoints to actual roads using OSRM (FREE!)
 * - Uses public OSRM server (or you can self-host)
 * - Returns road-following coordinates
 */
async function snapToRoadsOSRM(waypoints) {
    try {
        if (!waypoints || waypoints.length < 2) {
            logger.warn('⚠️ Need at least 2 waypoints for road snapping');
            return waypoints;
        }

        // OSRM has a limit of ~100 coordinates per request
        // If more points, we need to batch them
        const BATCH_SIZE = 100;
        let allSnappedPoints = [];

        for (let i = 0; i < waypoints.length; i += BATCH_SIZE - 1) {
            const batch = waypoints.slice(i, Math.min(i + BATCH_SIZE, waypoints.length));

            // Build coordinates string: "lng,lat;lng,lat;..."
            const coordinates = batch
                .map(wp => `${wp.longitude},${wp.latitude}`)
                .join(';');

            // Call OSRM Match API (matches GPS trace to road network)
            const url = `https://router.project-osrm.org/match/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;

            logger.debug(`🗺️ OSRM request: ${batch.length} points`);

            const response = await axios.get(url, { timeout: 10000 });

            if (response.data.code !== 'Ok' || !response.data.matchings || response.data.matchings.length === 0) {
                logger.warn('⚠️ OSRM matching failed, using GPS waypoints');
                allSnappedPoints.push(...batch);
                continue;
            }

            // Extract snapped coordinates from geometry
            const geometry = response.data.matchings[0].geometry;
            const snappedCoords = geometry.coordinates; // [lng, lat] pairs

            const snappedWaypoints = snappedCoords.map((coord, index) => ({
                latitude: coord[1],
                longitude: coord[0],
                speed: 0, // OSRM doesn't return speed
                recorded_at: new Date(),
                sequence_order: allSnappedPoints.length + index + 1
            }));

            allSnappedPoints.push(...snappedWaypoints);

            logger.info(`✅ OSRM batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} → ${snappedWaypoints.length} road points`);
        }

        logger.info(`✅ Total OSRM snapping: ${waypoints.length} → ${allSnappedPoints.length} road points`);
        return allSnappedPoints;

    } catch (error) {
        logger.error('🔥 OSRM road snapping error:', error.message);
        // Return original waypoints on error
        return waypoints;
    }
}

// ==================== API ENDPOINTS ====================

/**
 * Get trips for a specific vehicle
 * GET /api/trips/vehicle/:vehicleId
 */
exports.getVehicleTrips = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        logger.info(`ℹ️ Fetching trips for vehicle: ${vehicleId}`);

        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        const cacheKey = `trips:vehicle:${vehicleId}:page:${page}:limit:${limit}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trips for vehicle ${vehicleId}`);
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

        logger.info(`✅ Fetched ${result.rows.length} trips for vehicle ${vehicleId}`);

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
                address: formatAddress(
                    t.start_address,
                    t.start_address_status,
                    t.start_latitude,
                    t.start_longitude
                )
            },
            endLocation: {
                latitude: parseFloat(t.end_latitude),
                longitude: parseFloat(t.end_longitude),
                address: formatAddress(
                    t.end_address,
                    t.end_address_status,
                    t.end_latitude,
                    t.end_longitude
                )
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

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:details:${tripId}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trip details for ${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo', 'mac_id_gps']
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
                    address: formatAddress(
                        trip.start_address,
                        trip.start_address_status,
                        trip.start_latitude,
                        trip.start_longitude
                    )
                },
                endLocation: {
                    latitude: parseFloat(trip.end_latitude),
                    longitude: parseFloat(trip.end_longitude),
                    address: formatAddress(
                        trip.end_address,
                        trip.end_address_status,
                        trip.end_latitude,
                        trip.end_longitude
                    )
                },
                totalDistanceKm: parseFloat(trip.total_distance_km),
                avgSpeedKmh: parseFloat(trip.avg_speed_kmh),
                maxSpeedKmh: parseFloat(trip.max_speed_kmh),
                waypointCount: trip.waypoint_count,
                createdAt: trip.created_at
            }
        };

        await setCachedData(cacheKey, responseData);
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
 * ✅ FIXED: Get trip route (clean Laravel style + OSRM)
 * GET /api/trips/:tripId/route
 */
exports.getTripRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints } = req.query;

        logger.info(`ℹ️ Fetching trip route: ${tripId}`);

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const cacheKey = `trip:route:clean:${tripId}:limit:${limit}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached route for trip ${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            attributes: ['id', 'start_time', 'end_time', 'mac_id_gps', 'total_distance_km', 'waypoint_count'],
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['mac_id_gps']
            }]
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // ✅ Fetch waypoints (clean Laravel style)
        const waypoints = await fetchWaypointsFromLocations(trip, limit, MAX_DB_ROWS);

        if (waypoints.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No route data found"
            });
        }

        logger.info(`📍 Returning ${waypoints.length} clean GPS waypoints`);

        const responseData = {
            success: true,
            data: {
                tripId: parseInt(tripId),
                waypointCount: waypoints.length,
                sampledCount: waypoints.length,
                isSampled: waypoints.length < MAX_WAYPOINTS_FOR_MAP,
                route: waypoints.map(w => ({
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
 * ✅ FIXED: Get trip details with route (clean + OSRM snapping)
 * GET /api/trips/:tripId/details-with-route?snapToRoads=true
 */
exports.getTripDetailsWithRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints, snapToRoads } = req.query;

        logger.info(`ℹ️ Fetching trip details with route: ${tripId}`);

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const shouldSnapToRoads = snapToRoads === 'true' || snapToRoads === '1';

        const cacheKey = `trip:details-route:clean:${tripId}:limit:${limit}:snap:${shouldSnapToRoads}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`✅ Returning cached trip details with route for ${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo', 'mac_id_gps']
            }]
        });

        if (!trip) {
            logger.warn(`⚠️ Trip not found: ${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // ✅ Fetch clean GPS waypoints (Laravel style)
        let waypoints = await fetchWaypointsFromLocations(trip, limit, MAX_DB_ROWS);

        logger.info(`📍 Fetched ${waypoints.length} clean GPS waypoints`);

        // 🗺️ OSRM Road Snapping (if requested)
        let finalRoute = waypoints;
        let snappingApplied = false;

        if (shouldSnapToRoads && waypoints.length >= 2) {
            logger.info(`🗺️ Snapping route to roads with OSRM...`);

            try {
                const snappedRoute = await snapToRoadsOSRM(waypoints);

                if (snappedRoute && snappedRoute.length > waypoints.length * 0.3) {
                    finalRoute = snappedRoute;
                    snappingApplied = true;
                    logger.info(`✅ OSRM snapping: ${waypoints.length} → ${snappedRoute.length} road points`);
                } else {
                    logger.warn('⚠️ OSRM returned insufficient points, using GPS waypoints');
                }
            } catch (error) {
                logger.error('🔥 OSRM snapping failed:', error.message);
            }
        }

        logger.info(`📊 Returning ${finalRoute.length} waypoints (snapped: ${snappingApplied})`);

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
                        address: formatAddress(
                            trip.start_address,
                            trip.start_address_status,
                            trip.start_latitude,
                            trip.start_longitude
                        )
                    },
                    endLocation: {
                        latitude: parseFloat(trip.end_latitude),
                        longitude: parseFloat(trip.end_longitude),
                        address: formatAddress(
                            trip.end_address,
                            trip.end_address_status,
                            trip.end_latitude,
                            trip.end_longitude
                        )
                    },
                    totalDistanceKm: parseFloat(trip.total_distance_km),
                    avgSpeedKmh: parseFloat(trip.avg_speed_kmh),
                    maxSpeedKmh: parseFloat(trip.max_speed_kmh),
                    waypointCount: trip.waypoint_count,
                    createdAt: trip.created_at
                },
                waypoints: finalRoute.map(w => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed || 0),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                })),
                metadata: {
                    totalWaypoints: waypoints.length,
                    returnedWaypoints: finalRoute.length,
                    isSampled: waypoints.length >= MAX_WAYPOINTS_FOR_MAP,
                    isSnappedToRoads: snappingApplied,
                    samplingRatio: waypoints.length > 0
                        ? (finalRoute.length / waypoints.length).toFixed(2)
                        : 1,
                    tripDistanceKm: parseFloat(trip.total_distance_km),
                    source: snappingApplied ? 'osrm_roads' : 'clean_gps'
                }
            }
        };

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

// ==================== REMAINING ENDPOINTS (unchanged) ====================

exports.getVehicleTripStats = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate } = req.query;

        logger.info(`ℹ️ Fetching trip stats for vehicle: ${vehicleId}`);

        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        const cacheKey = `trip:stats:${vehicleId}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const vehicle = await Voiture.findByPk(vehicleId, { attributes: ['id'] });

        if (!vehicle) {
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

        if (!trips.length) {
            const responseData = {
                success: true,
                data: {
                    totalTrips: 0,
                    totalDistanceKm: 0,
                    totalDurationMinutes: 0,
                    avgSpeed: 0,
                    maxSpeed: 0,
                    message: "No trips found"
                }
            };
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

exports.getAllTrips = async (req, res) => {
    try {
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        const cacheKey = `trips:all:page:${page}:limit:${limit}:start:${startDate || 'none'}:end:${endDate || 'none'}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
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

        const responseData = { success: true, data: result };
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

exports.deleteTrip = async (req, res) => {
    try {
        const { tripId } = req.params;

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        const vehicleId = trip.vehicle_id;

        await trip.destroy();
        logger.info(`✅ Trip deleted: ${tripId}`);

        await deleteCachedData(`trip:*${tripId}*`);
        await deleteCachedData(`trips:vehicle:${vehicleId}:*`);
        await deleteCachedData(`trips:all:*`);

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

exports.getTripFull = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`ℹ️ Fetching FULL trip: ${tripId}`);

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:full:clean:${tripId}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'immatriculation', 'marque', 'model', 'couleur', 'photo', 'mac_id_gps']
            }]
        });

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        // ✅ Fetch ALL waypoints (focus mode)
        const waypoints = await fetchWaypointsFromLocations(trip, MAX_WAYPOINTS_FOR_FOCUS, MAX_DB_ROWS_FOCUS);

        logger.info(`📍 Fetched ${waypoints.length} waypoints (FULL)`);

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
                        address: formatAddress(
                            trip.start_address,
                            trip.start_address_status,
                            trip.start_latitude,
                            trip.start_longitude
                        )
                    },
                    endLocation: {
                        latitude: parseFloat(trip.end_latitude),
                        longitude: parseFloat(trip.end_longitude),
                        address: formatAddress(
                            trip.end_address,
                            trip.end_address_status,
                            trip.end_latitude,
                            trip.end_longitude
                        )
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

        await setCachedData(cacheKey, responseData);
        res.json(responseData);

    } catch (error) {
        logger.error("🔥 Error in getTripFull:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch full trip",
            error: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
};

module.exports = exports;