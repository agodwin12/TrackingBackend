// controllers/tripController.js
const { Op } = require("sequelize");
const Trip = require("../models/trip");
const Location = require("../models/location");
const Voiture = require("../models/voiture");
const redisClient = require("../config/redis");
const logger = require("../utils/logger");
const axios = require("axios");

// Cache TTL
const TRIP_CACHE_TTL = 300;
const EMPTY_RESULT_TTL = 60;

// Limits
const MAX_WAYPOINTS_FOR_MAP = 1500;
const MAX_WAYPOINTS_FOR_FOCUS = 20000;
const MAX_DB_ROWS = 20000;
const MAX_DB_ROWS_FOCUS = 120000;
const STATS_TRIP_LIMIT = 1000;

// ✅ OSRM URL from env — localhost:5000 for dev, http://osrm:5000 for Docker prod
const OSRM_URL = process.env.OSRM_URL || "http://localhost:5000";

// ==================== DATE PARSING ====================

function parseLocalDayStart(dateStr) {
    if (!dateStr) return null;
    const datePart = dateStr.split("T")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    const d = new Date(`${datePart}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
}

function parseLocalDayEnd(dateStr) {
    if (!dateStr) return null;
    const datePart = dateStr.split("T")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    const d = new Date(`${datePart}T23:59:59`);
    return isNaN(d.getTime()) ? null : d;
}

// ==================== ADDRESS HANDLING ====================

function formatAddress(address, addressStatus, latitude, longitude) {
    if (
        addressStatus === "geocoded" &&
        address &&
        address !== "Unknown location" &&
        address !== "Geocoding..." &&
        !address.includes("°")
    ) {
        return address;
    }

    if (addressStatus === "pending") {
        return "Geocoding...";
    }

    if (latitude && longitude) {
        return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
    }

    return "Unknown location";
}

function extractCityFromAddress(fullAddress) {
    if (!fullAddress || fullAddress.includes("°")) return null;

    const parts = fullAddress.split(",").map((p) => p.trim());

    if (parts.length >= 2) {
        const cityCandidate = parts[parts.length - 2];
        if (cityCandidate && cityCandidate.length > 2 && !cityCandidate.match(/^\d/)) {
            return cityCandidate;
        }
    }

    if (parts.length >= 1) {
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
        if (!redisClient.isConnected) {
            logger.warn(`[TRIP CACHE] Redis not connected, skipping GET for key=${key}`);
            return null;
        }
        const cached = await redisClient.get(key);
        if (cached) {
            logger.debug(`[TRIP CACHE] HIT key=${key}`);
            return JSON.parse(cached);
        }
        logger.debug(`[TRIP CACHE] MISS key=${key}`);
        return null;
    } catch (error) {
        logger.error(`[TRIP CACHE] GET error key=${key} message=${error.message}`, {
            stack: error.stack
        });
        return null;
    }
}

async function setCachedData(key, data, ttl = TRIP_CACHE_TTL) {
    try {
        if (!redisClient.isConnected) {
            logger.warn(`[TRIP CACHE] Redis not connected, skipping SET for key=${key}`);
            return;
        }
        await redisClient.setEx(key, ttl, JSON.stringify(data));
        logger.debug(`[TRIP CACHE] SET key=${key} ttl=${ttl}`);
    } catch (error) {
        logger.error(`[TRIP CACHE] SET error key=${key} message=${error.message}`, {
            stack: error.stack
        });
    }
}

async function deleteCachedData(pattern) {
    try {
        if (!redisClient.isConnected) {
            logger.warn(`[TRIP CACHE] Redis not connected, skipping DELETE for pattern=${pattern}`);
            return;
        }
        if (pattern.includes("*")) {
            const keys = await redisClient.keys(pattern);
            logger.info(`[TRIP CACHE] DELETE pattern=${pattern} matchedKeys=${keys.length}`);
            if (keys.length > 0) {
                await redisClient.del(...keys);
            }
        } else {
            await redisClient.del(pattern);
            logger.info(`[TRIP CACHE] DELETE key=${pattern}`);
        }
    } catch (error) {
        logger.error(`[TRIP CACHE] DELETE error pattern=${pattern} message=${error.message}`, {
            stack: error.stack
        });
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

function safeDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

function reqMeta(req) {
    return {
        method: req.method,
        originalUrl: req.originalUrl,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        query: req.query,
        params: req.params
    };
}

// ==================== GPS TRACK BUILDING ====================

async function fetchWaypointsFromLocations(trip, maxPoints = MAX_WAYPOINTS_FOR_MAP, maxDbRows = MAX_DB_ROWS) {
    try {
        logger.info(
            `[TRIP WAYPOINTS] Start fetch tripId=${trip.id} vehicleId=${trip.vehicle_id || "n/a"} maxPoints=${maxPoints} maxDbRows=${maxDbRows}`
        );

        const TripWaypoint = require("../models/tripWaypoint");

        const rows = await TripWaypoint.findAll({
            where: { trip_id: trip.id },
            attributes: ["latitude", "longitude", "speed", "recorded_at", "sequence_order"],
            order: [["sequence_order", "ASC"]],
            limit: maxDbRows,
            raw: true
        });

        logger.info(`[TRIP WAYPOINTS] Raw DB result tripId=${trip.id} waypointCount=${rows.length}`);

        if (rows.length === 0) {
            logger.warn(`[TRIP WAYPOINTS] No waypoints found in trip_waypoints for tripId=${trip.id}`);
            return [];
        }

        // Filter invalid coordinates
        const points = [];
        let invalidCoordCount = 0;

        for (const row of rows) {
            const lat = parseFloat(row.latitude);
            const lng = parseFloat(row.longitude);

            if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                invalidCoordCount++;
                continue;
            }

            points.push({
                latitude: lat,
                longitude: lng,
                speed: parseFloat(row.speed || 0),
                recorded_at: row.recorded_at,
                sequence_order: row.sequence_order
            });
        }

        if (invalidCoordCount > 0) {
            logger.warn(`[TRIP WAYPOINTS] Skipped ${invalidCoordCount} invalid coordinates for tripId=${trip.id}`);
        }

        // Downsample if over the maxPoints cap
        let finalPoints = points;
        let samplingStep = 1;

        if (points.length > maxPoints) {
            samplingStep = Math.ceil(points.length / maxPoints);
            const reduced = [];

            for (let i = 0; i < points.length; i += samplingStep) {
                reduced.push(points[i]);
            }

            // Always include the last point
            const lastPoint = points[points.length - 1];
            if (reduced.length === 0 || reduced[reduced.length - 1] !== lastPoint) {
                reduced.push(lastPoint);
            }

            finalPoints = reduced;
        }

        logger.info(
            `[TRIP WAYPOINTS] Final tripId=${trip.id} returned=${finalPoints.length} sampled=${points.length > maxPoints} step=${samplingStep}`
        );

        return finalPoints.map((point, index) => ({
            ...point,
            sequence_order: index + 1
        }));

    } catch (error) {
        logger.error(`[TRIP WAYPOINTS] Error fetching waypoints for tripId=${trip?.id || "unknown"} message=${error.message}`, {
            tripId: trip?.id,
            vehicleId: trip?.vehicle_id,
            stack: error.stack
        });
        return [];
    }
}

// ==================== OSRM ROAD SNAPPING ====================

/**
 * Snap GPS waypoints to roads using local OSRM instance.
 *
 * FIX: The old code used BATCH_SIZE - 1 as the step, which caused batches to
 * overlap by 1 point (correct) but then the slice was also BATCH_SIZE wide,
 * meaning the overlap point appeared twice in allSnappedPoints. Fixed below:
 * - Each batch is exactly BATCH_SIZE points
 * - Batches overlap by 1 point so OSRM can join them seamlessly
 * - The overlapping point is stripped from the start of each batch result
 *   (except the first batch) before appending
 */
async function snapToRoadsOSRM(waypoints) {
    try {
        if (!waypoints || waypoints.length < 2) {
            logger.warn(`[TRIP OSRM] Need at least 2 waypoints, got ${waypoints?.length || 0}`);
            return waypoints;
        }

        // OSRM match API accepts up to 100 coordinates per request
        const BATCH_SIZE = 100;
        let allSnappedPoints = [];
        let batchIndex = 0;

        for (let i = 0; i < waypoints.length; i += BATCH_SIZE - 1) {
            // Slice a batch of up to BATCH_SIZE points
            const batch = waypoints.slice(i, i + BATCH_SIZE);

            // Build coordinate string: "lng,lat;lng,lat;..."
            const coordinates = batch
                .map((wp) => `${wp.longitude},${wp.latitude}`)
                .join(";");

            // ✅ Use local OSRM from env var
            const url = `${OSRM_URL}/match/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;

            logger.debug(`[TRIP OSRM] Request batchIndex=${batchIndex + 1} batchSize=${batch.length} url=${OSRM_URL}`);

            try {
                const response = await axios.get(url, { timeout: 10000 });

                if (
                    response.data.code !== "Ok" ||
                    !response.data.matchings ||
                    response.data.matchings.length === 0
                ) {
                    // OSRM could not match this batch — fall back to raw GPS for this batch
                    logger.warn(`[TRIP OSRM] Matching failed for batchIndex=${batchIndex + 1} code=${response.data.code}, using raw GPS points`);

                    // ✅ FIX: skip the first point on subsequent batches to avoid duplicates
                    const batchPoints = batchIndex === 0 ? batch : batch.slice(1);
                    allSnappedPoints.push(...batchPoints.map((wp, idx) => ({
                        latitude: wp.latitude,
                        longitude: wp.longitude,
                        speed: wp.speed || 0,
                        recorded_at: wp.recorded_at,
                        sequence_order: allSnappedPoints.length + idx + 1
                    })));

                    batchIndex++;
                    continue;
                }

                // Collect all matched geometry coordinates across all matchings
                // (OSRM may split one batch into multiple matchings for disconnected roads)
                const snappedCoords = [];
                for (const matching of response.data.matchings) {
                    snappedCoords.push(...matching.geometry.coordinates);
                }

                // ✅ FIX: skip the first snapped point on subsequent batches to avoid
                // duplicating the join point between batches
                const coordsToAdd = batchIndex === 0 ? snappedCoords : snappedCoords.slice(1);

                const snappedWaypoints = coordsToAdd.map((coord, idx) => ({
                    latitude: coord[1],   // GeoJSON is [lng, lat]
                    longitude: coord[0],
                    speed: 0,
                    recorded_at: new Date(),
                    sequence_order: allSnappedPoints.length + idx + 1
                }));

                allSnappedPoints.push(...snappedWaypoints);

                logger.info(
                    `[TRIP OSRM] Batch success batchIndex=${batchIndex + 1} input=${batch.length} output=${snappedWaypoints.length} total=${allSnappedPoints.length}`
                );

            } catch (batchError) {
                // Network error or timeout for this batch — fall back to raw GPS
                logger.error(`[TRIP OSRM] Batch ${batchIndex + 1} request failed: ${batchError.message}`);

                const batchPoints = batchIndex === 0 ? batch : batch.slice(1);
                allSnappedPoints.push(...batchPoints.map((wp, idx) => ({
                    latitude: wp.latitude,
                    longitude: wp.longitude,
                    speed: wp.speed || 0,
                    recorded_at: wp.recorded_at,
                    sequence_order: allSnappedPoints.length + idx + 1
                })));
            }

            batchIndex++;
        }

        logger.info(`[TRIP OSRM] Total snapping input=${waypoints.length} output=${allSnappedPoints.length}`);
        return allSnappedPoints;

    } catch (error) {
        logger.error(`[TRIP OSRM] Fatal error message=${error.message}`, { stack: error.stack });
        // Return original waypoints so the trip still renders
        return waypoints;
    }
}

// ==================== API ENDPOINTS ====================

exports.getVehicleTrips = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        logger.info(`[GET VEHICLE TRIPS] Incoming request`, reqMeta(req));

        if (!vehicleId || isNaN(vehicleId)) {
            logger.warn(`[GET VEHICLE TRIPS] Invalid vehicle ID: ${vehicleId}`);
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        const cacheKey = `trips:vehicle:${vehicleId}:page:${page}:limit:${limit}:start:${startDate || "none"}:end:${endDate || "none"}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`[GET VEHICLE TRIPS] Returning cached response vehicleId=${vehicleId}`);
            return res.json(cachedData);
        }

        const vehicle = await Voiture.findByPk(vehicleId, {
            attributes: ["id", "immatriculation", "mac_id_gps"]
        });

        if (!vehicle) {
            logger.warn(`[GET VEHICLE TRIPS] Vehicle not found vehicleId=${vehicleId}`);
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        logger.info(`[GET VEHICLE TRIPS] Vehicle found`, {
            id: vehicle.id,
            immatriculation: vehicle.immatriculation,
            mac_id_gps: vehicle.mac_id_gps
        });

        const whereClause = {
            vehicle_id: vehicleId,
            status: "completed"
        };

        if (startDate || endDate) {
            whereClause.start_time = {};

            if (startDate) {
                const parsedStart = parseLocalDayStart(startDate);
                logger.info(`[GET VEHICLE TRIPS] Parsed startDate raw=${startDate} parsed=${parsedStart?.toLocaleString() || "invalid"}`);
                if (!parsedStart) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid startDate — expected yyyy-MM-dd"
                    });
                }
                whereClause.start_time[Op.gte] = parsedStart;
            }

            if (endDate) {
                const parsedEnd = parseLocalDayEnd(endDate);
                logger.info(`[GET VEHICLE TRIPS] Parsed endDate raw=${endDate} parsed=${parsedEnd?.toLocaleString() || "invalid"}`);
                if (!parsedEnd) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid endDate — expected yyyy-MM-dd"
                    });
                }
                whereClause.start_time[Op.lte] = parsedEnd;
                logger.info(`[GET VEHICLE TRIPS] endDate inclusive upper bound=${parsedEnd.toLocaleString()}`);
            }
        }

        logger.info(`[GET VEHICLE TRIPS] Final whereClause`, whereClause);

        const offset = (page - 1) * limit;

        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["immatriculation", "marque", "model", "couleur"]
            }],
            order: [["start_time", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        logger.info(
            `[GET VEHICLE TRIPS] Query result vehicleId=${vehicleId} count=${result.count} returnedRows=${result.rows.length} page=${page} limit=${limit} offset=${offset}`
        );

        if (result.rows.length > 0) {
            logger.info(`[GET VEHICLE TRIPS] Returned trip boundary IDs`, {
                firstTripId: result.rows[0].id,
                firstTripStart: result.rows[0].start_time,
                lastTripId: result.rows[result.rows.length - 1].id,
                lastTripStart: result.rows[result.rows.length - 1].start_time
            });
        } else {
            logger.warn(`[GET VEHICLE TRIPS] No trips found for vehicleId=${vehicleId} with requested filters`);
        }

        const trips = result.rows.map((t) => ({
            id: t.id,
            vehicleId: t.vehicle_id,
            vehicleInfo: {
                immatriculation: t.vehicle?.immatriculation,
                marque: t.vehicle?.marque,
                model: t.vehicle?.model,
                couleur: t.vehicle?.couleur
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
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET VEHICLE TRIPS] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch vehicle trips",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getTripDetails = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`[GET TRIP DETAILS] Incoming request`, reqMeta(req));

        if (!tripId || isNaN(tripId)) {
            logger.warn(`[GET TRIP DETAILS] Invalid trip ID: ${tripId}`);
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:details:${tripId}`;
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`[GET TRIP DETAILS] Returning cached response tripId=${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["id", "immatriculation", "marque", "model", "couleur", "photo", "mac_id_gps"]
            }]
        });

        if (!trip) {
            logger.warn(`[GET TRIP DETAILS] Trip not found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        logger.info(`[GET TRIP DETAILS] Trip found`, {
            tripId: trip.id,
            vehicleId: trip.vehicle_id,
            start_time: trip.start_time,
            end_time: trip.end_time,
            status: trip.status,
            mac_id_gps_trip: trip.mac_id_gps,
            mac_id_gps_vehicle: trip.vehicle?.mac_id_gps
        });

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
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET TRIP DETAILS] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trip details",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getTripRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints } = req.query;

        logger.info(`[GET TRIP ROUTE] Incoming request`, reqMeta(req));

        if (!tripId || isNaN(tripId)) {
            logger.warn(`[GET TRIP ROUTE] Invalid trip ID: ${tripId}`);
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const cacheKey = `trip:route:clean:${tripId}:limit:${limit}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`[GET TRIP ROUTE] Returning cached response tripId=${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            attributes: ["id", "vehicle_id", "start_time", "end_time", "mac_id_gps", "total_distance_km", "waypoint_count"],
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["mac_id_gps"]
            }]
        });

        if (!trip) {
            logger.warn(`[GET TRIP ROUTE] Trip not found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        logger.info(`[GET TRIP ROUTE] Trip found`, {
            tripId: trip.id,
            vehicleId: trip.vehicle_id,
            start_time: trip.start_time,
            end_time: trip.end_time,
            mac_id_gps_trip: trip.mac_id_gps,
            mac_id_gps_vehicle: trip.vehicle?.mac_id_gps,
            requestedMaxPoints: limit
        });

        const waypoints = await fetchWaypointsFromLocations(trip, limit, MAX_DB_ROWS);

        if (waypoints.length === 0) {
            logger.warn(`[GET TRIP ROUTE] No route data found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "No route data found"
            });
        }

        logger.info(`[GET TRIP ROUTE] Returning route tripId=${tripId} waypointCount=${waypoints.length}`);

        const responseData = {
            success: true,
            data: {
                tripId: parseInt(tripId),
                waypointCount: waypoints.length,
                sampledCount: waypoints.length,
                isSampled: waypoints.length < MAX_WAYPOINTS_FOR_MAP,
                route: waypoints.map((w) => ({
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
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET TRIP ROUTE] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trip route",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getTripDetailsWithRoute = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { maxPoints, snapToRoads } = req.query;

        logger.info(`[GET TRIP DETAILS WITH ROUTE] Incoming request`, reqMeta(req));

        if (!tripId || isNaN(tripId)) {
            logger.warn(`[GET TRIP DETAILS WITH ROUTE] Invalid trip ID: ${tripId}`);
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const limit = maxPoints ? parseInt(maxPoints) : MAX_WAYPOINTS_FOR_MAP;
        const shouldSnapToRoads = snapToRoads === "true" || snapToRoads === "1";
        const cacheKey = `trip:details-route:clean:${tripId}:limit:${limit}:snap:${shouldSnapToRoads}`;

        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`[GET TRIP DETAILS WITH ROUTE] Returning cached response tripId=${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["id", "immatriculation", "marque", "model", "couleur", "photo", "mac_id_gps"]
            }]
        });

        if (!trip) {
            logger.warn(`[GET TRIP DETAILS WITH ROUTE] Trip not found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        logger.info(`[GET TRIP DETAILS WITH ROUTE] Trip found`, {
            tripId: trip.id,
            vehicleId: trip.vehicle_id,
            start_time: trip.start_time,
            end_time: trip.end_time,
            total_distance_km: trip.total_distance_km,
            waypoint_count: trip.waypoint_count,
            shouldSnapToRoads,
            limit,
            osrmUrl: OSRM_URL
        });

        // ── Fetch waypoints from trip_waypoints table ──────────────────────────
        let waypoints = await fetchWaypointsFromLocations(trip, limit, MAX_DB_ROWS);
        logger.info(`[GET TRIP DETAILS WITH ROUTE] GPS waypoints fetched tripId=${tripId} count=${waypoints.length}`);

        // ── Fallback: if trip_waypoints is empty use start/end from trips table ─
        // This covers edge cases (very old trips, detection service gaps).
        // We return a 2-point straight line so Flutter still renders something.
        let usingFallback = false;

        if (waypoints.length === 0) {
            const startLat = parseFloat(trip.start_latitude);
            const startLng = parseFloat(trip.start_longitude);
            const endLat   = parseFloat(trip.end_latitude);
            const endLng   = parseFloat(trip.end_longitude);

            const validStart = startLat && startLng && Math.abs(startLat) <= 90 && Math.abs(startLng) <= 180;
            const validEnd   = endLat   && endLng   && Math.abs(endLat)   <= 90 && Math.abs(endLng)   <= 180;

            if (validStart && validEnd) {
                logger.warn(`[GET TRIP DETAILS WITH ROUTE] No waypoints for tripId=${tripId} — using start/end fallback`);
                waypoints = [
                    { latitude: startLat, longitude: startLng, speed: 0, recorded_at: trip.start_time, sequence_order: 1 },
                    { latitude: endLat,   longitude: endLng,   speed: 0, recorded_at: trip.end_time,   sequence_order: 2 }
                ];
                usingFallback = true;
            } else {
                logger.warn(`[GET TRIP DETAILS WITH ROUTE] No waypoints and no valid coords for tripId=${tripId}`);
                return res.status(404).json({
                    success: false,
                    message: "No route data available for this trip"
                });
            }
        }

        // ── OSRM road snapping ─────────────────────────────────────────────────
        // Skip snapping for fallback (only 2 points — not meaningful to snap)
        let finalRoute = waypoints;
        let snappingApplied = false;

        if (shouldSnapToRoads && !usingFallback && waypoints.length >= 2) {
            logger.info(`[GET TRIP DETAILS WITH ROUTE] Starting OSRM snapping tripId=${tripId} osrmUrl=${OSRM_URL}`);

            try {
                const snappedRoute = await snapToRoadsOSRM(waypoints);

                // Accept the snapped result only if it has a reasonable number of points.
                // Threshold: at least 30% of the input count.
                if (snappedRoute && snappedRoute.length >= Math.max(2, waypoints.length * 0.3)) {
                    finalRoute = snappedRoute;
                    snappingApplied = true;
                    logger.info(`[GET TRIP DETAILS WITH ROUTE] OSRM applied tripId=${tripId} input=${waypoints.length} output=${snappedRoute.length}`);
                } else {
                    logger.warn(`[GET TRIP DETAILS WITH ROUTE] OSRM result too sparse tripId=${tripId} — using raw GPS`);
                }
            } catch (osrmError) {
                // Non-fatal — raw GPS waypoints are still a valid fallback
                logger.error(`[GET TRIP DETAILS WITH ROUTE] OSRM failed tripId=${tripId} message=${osrmError.message}`, {
                    stack: osrmError.stack
                });
            }
        }

        logger.info(
            `[GET TRIP DETAILS WITH ROUTE] Response ready tripId=${tripId} totalWaypoints=${waypoints.length} returnedWaypoints=${finalRoute.length} snapped=${snappingApplied} fallback=${usingFallback}`
        );

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
                waypoints: finalRoute.map((w) => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed || 0),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                })),
                metadata: {
                    totalWaypoints: usingFallback ? 0 : waypoints.length,
                    returnedWaypoints: finalRoute.length,
                    isSampled: !usingFallback && waypoints.length >= MAX_WAYPOINTS_FOR_MAP,
                    isSnappedToRoads: snappingApplied,
                    isFallback: usingFallback,
                    samplingRatio: waypoints.length > 0
                        ? parseFloat((finalRoute.length / waypoints.length).toFixed(2))
                        : 1,
                    tripDistanceKm: parseFloat(trip.total_distance_km),
                    source: usingFallback
                        ? "start_end_only"
                        : snappingApplied
                            ? "osrm_roads"
                            : "raw_gps"
                }
            }
        };

        // ✅ Do not cache fallback responses — real waypoints may appear later
        if (!usingFallback) {
            await setCachedData(cacheKey, responseData);
        }

        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET TRIP DETAILS WITH ROUTE] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trip details with route",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getTripFull = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`[GET FULL TRIP] Incoming request`, reqMeta(req));

        if (!tripId || isNaN(tripId)) {
            logger.warn(`[GET FULL TRIP] Invalid trip ID: ${tripId}`);
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const cacheKey = `trip:full:clean:${tripId}`;
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            logger.info(`[GET FULL TRIP] Returning cached response tripId=${tripId}`);
            return res.json(cachedData);
        }

        const trip = await Trip.findByPk(tripId, {
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["id", "immatriculation", "marque", "model", "couleur", "photo", "mac_id_gps"]
            }]
        });

        if (!trip) {
            logger.warn(`[GET FULL TRIP] Trip not found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        logger.info(`[GET FULL TRIP] Trip found`, {
            tripId: trip.id,
            vehicleId: trip.vehicle_id,
            tripStatus: trip.status,
            start_time: trip.start_time,
            end_time: trip.end_time,
            duration_minutes: trip.duration_minutes,
            trip_mac_id_gps: trip.mac_id_gps,
            vehicle_mac_id_gps: trip.vehicle?.mac_id_gps,
            total_distance_km: trip.total_distance_km,
            waypoint_count_db: trip.waypoint_count
        });

        const waypoints = await fetchWaypointsFromLocations(
            trip,
            MAX_WAYPOINTS_FOR_FOCUS,
            MAX_DB_ROWS_FOCUS
        );

        logger.info(`[GET FULL TRIP] Waypoints result tripId=${tripId} count=${waypoints.length}`);

        if (waypoints.length === 0) {
            logger.warn(`[GET FULL TRIP] No waypoints found for full trip tripId=${tripId}`);
        } else {
            logger.info(`[GET FULL TRIP] Waypoint boundaries tripId=${tripId}`, {
                firstWaypoint: waypoints[0],
                lastWaypoint: waypoints[waypoints.length - 1]
            });
        }

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
                waypoints: waypoints.map((w) => ({
                    latitude: parseFloat(w.latitude),
                    longitude: parseFloat(w.longitude),
                    speed: parseFloat(w.speed || 0),
                    timestamp: w.recorded_at,
                    order: w.sequence_order
                }))
            }
        };

        logger.info(`[GET FULL TRIP] Response ready tripId=${tripId} success=true`);

        await setCachedData(cacheKey, responseData);
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET FULL TRIP] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch full trip",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getVehicleTripStats = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate } = req.query;

        logger.info(`[GET VEHICLE TRIP STATS] Incoming request`, reqMeta(req));

        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vehicle ID"
            });
        }

        const cacheKey = `trip:stats:${vehicleId}:start:${startDate || "none"}:end:${endDate || "none"}`;
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const vehicle = await Voiture.findByPk(vehicleId, { attributes: ["id"] });
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const whereClause = {
            vehicle_id: vehicleId,
            status: "completed"
        };

        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) {
                const parsedStart = parseLocalDayStart(startDate);
                if (!parsedStart) {
                    return res.status(400).json({ success: false, message: "Invalid startDate — expected yyyy-MM-dd" });
                }
                whereClause.start_time[Op.gte] = parsedStart;
            }
            if (endDate) {
                const parsedEnd = parseLocalDayEnd(endDate);
                if (!parsedEnd) {
                    return res.status(400).json({ success: false, message: "Invalid endDate — expected yyyy-MM-dd" });
                }
                whereClause.start_time[Op.lte] = parsedEnd;
            }
        }

        logger.info(`[GET VEHICLE TRIP STATS] whereClause`, whereClause);

        const trips = await Trip.findAll({
            where: whereClause,
            attributes: [
                "total_distance_km",
                "duration_minutes",
                "avg_speed_kmh",
                "max_speed_kmh"
            ],
            limit: STATS_TRIP_LIMIT,
            order: [["start_time", "DESC"]],
            raw: true
        });

        logger.info(`[GET VEHICLE TRIP STATS] tripsFound=${trips.length}`);

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
        const maxSpeed = Math.max(...trips.map((t) => parseFloat(t.max_speed_kmh || 0)));

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
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET VEHICLE TRIP STATS] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trip statistics",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.getAllTrips = async (req, res) => {
    try {
        const { startDate, endDate, page = 1, limit = 50 } = req.query;

        logger.info(`[GET ALL TRIPS] Incoming request`, reqMeta(req));

        const cacheKey = `trips:all:page:${page}:limit:${limit}:start:${startDate || "none"}:end:${endDate || "none"}`;
        const cachedData = await getCachedData(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const whereClause = { status: "completed" };

        if (startDate || endDate) {
            whereClause.start_time = {};
            if (startDate) {
                const parsedStart = parseLocalDayStart(startDate);
                if (!parsedStart) {
                    return res.status(400).json({ success: false, message: "Invalid startDate — expected yyyy-MM-dd" });
                }
                whereClause.start_time[Op.gte] = parsedStart;
            }
            if (endDate) {
                const parsedEnd = parseLocalDayEnd(endDate);
                if (!parsedEnd) {
                    return res.status(400).json({ success: false, message: "Invalid endDate — expected yyyy-MM-dd" });
                }
                whereClause.start_time[Op.lte] = parsedEnd;
            }
        }

        logger.info(`[GET ALL TRIPS] whereClause`, whereClause);

        const offset = (page - 1) * limit;
        const result = await Trip.findAndCountAll({
            where: whereClause,
            include: [{
                model: Voiture,
                as: "vehicle",
                attributes: ["immatriculation", "marque", "model"]
            }],
            order: [["start_time", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        logger.info(`[GET ALL TRIPS] count=${result.count} returnedRows=${result.rows.length}`);

        const responseData = { success: true, data: result };
        await setCachedData(cacheKey, responseData);
        return res.json(responseData);

    } catch (error) {
        logger.error(`[GET ALL TRIPS] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trips",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

exports.deleteTrip = async (req, res) => {
    try {
        const { tripId } = req.params;

        logger.info(`[DELETE TRIP] Incoming request`, reqMeta(req));

        if (!tripId || isNaN(tripId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid trip ID"
            });
        }

        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            logger.warn(`[DELETE TRIP] Trip not found tripId=${tripId}`);
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        const vehicleId = trip.vehicle_id;

        await trip.destroy();
        logger.info(`[DELETE TRIP] Trip deleted tripId=${tripId} vehicleId=${vehicleId}`);

        await deleteCachedData(`trip:*${tripId}*`);
        await deleteCachedData(`trips:vehicle:${vehicleId}:*`);
        await deleteCachedData(`trips:all:*`);

        return res.json({
            success: true,
            message: "Trip deleted successfully"
        });

    } catch (error) {
        logger.error(`[DELETE TRIP] Failed message=${error.message}`, {
            meta: reqMeta(req),
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: "Failed to delete trip",
            error: process.env.NODE_ENV === "production" ? undefined : error.message
        });
    }
};

module.exports = exports;