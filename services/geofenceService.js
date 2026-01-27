// services/geofenceService.js - ENHANCED COORDINATE DETECTION

const turf = require("@turf/turf");
const logger = require("../utils/logger");

// ==================== CAMEROON COORDINATE BOUNDS ====================
const CAMEROON_BOUNDS = {
    LAT_MIN: 1.5,   // Southern boundary (slightly extended)
    LAT_MAX: 13.5,  // Northern boundary (slightly extended)
    LNG_MIN: 8.0,   // Western boundary
    LNG_MAX: 16.5   // Eastern boundary (slightly extended)
};

/**
 * Safely parse geofence zone that may come as:
 * - Array of pairs: [[a,b],[a,b],...]
 * - JSON string of the above
 */
const parseGeofenceZone = (geofenceZone) => {
    if (!geofenceZone) return null;

    // If it comes from MySQL as a JSON string
    if (typeof geofenceZone === "string") {
        try {
            const parsed = JSON.parse(geofenceZone);
            return parsed;
        } catch (e) {
            logger.warn("⚠️ Geofence zone is a string but not valid JSON");
            return null;
        }
    }

    return geofenceZone;
};

/**
 * ✅ ENHANCED: Detect coordinate format using multiple strategies
 * Returns: 'lat-lng' | 'lng-lat' | 'ambiguous'
 */
const detectCoordinateFormat = (coordinates, currentLat, currentLng) => {
    if (!Array.isArray(coordinates) || coordinates.length < 1) {
        return 'unknown';
    }

    const firstPoint = coordinates[0];
    if (!Array.isArray(firstPoint) || firstPoint.length < 2) {
        return 'unknown';
    }

    const [a0, b0] = [Number(firstPoint[0]), Number(firstPoint[1])];

    logger.debug(`🔍 Coordinate Detection:`);
    logger.debug(`   First point: [${a0}, ${b0}]`);
    logger.debug(`   Current vehicle: [${currentLat}, ${currentLng}]`);

    // ==================== STRATEGY 1: ABSOLUTE LAT/LNG BOUNDS ====================
    // Latitude MUST be in [-90, 90]. Longitude can be [-180, 180]

    // If first value is outside [-90, 90], it MUST be longitude
    if (Math.abs(a0) > 90 && Math.abs(a0) <= 180) {
        logger.info(`✅ DETECTED [lng, lat]: First value ${a0} is outside latitude range`);
        return 'lng-lat';
    }

    // If second value is outside [-90, 90], it MUST be longitude
    if (Math.abs(b0) > 90 && Math.abs(b0) <= 180) {
        logger.info(`✅ DETECTED [lat, lng]: Second value ${b0} is outside latitude range`);
        return 'lat-lng';
    }

    // ==================== STRATEGY 2: CAMEROON-SPECIFIC BOUNDS ====================
    // For Cameroon: lat (2-13), lng (8-16)

    const a0InCameroonLat = a0 >= CAMEROON_BOUNDS.LAT_MIN && a0 <= CAMEROON_BOUNDS.LAT_MAX;
    const b0InCameroonLat = b0 >= CAMEROON_BOUNDS.LAT_MIN && b0 <= CAMEROON_BOUNDS.LAT_MAX;
    const a0InCameroonLng = a0 >= CAMEROON_BOUNDS.LNG_MIN && a0 <= CAMEROON_BOUNDS.LNG_MAX;
    const b0InCameroonLng = b0 >= CAMEROON_BOUNDS.LNG_MIN && b0 <= CAMEROON_BOUNDS.LNG_MAX;

    logger.debug(`📍 Cameroon Bounds Check:`);
    logger.debug(`   First value ${a0}: inLatRange=${a0InCameroonLat}, inLngRange=${a0InCameroonLng}`);
    logger.debug(`   Second value ${b0}: inLatRange=${b0InCameroonLat}, inLngRange=${b0InCameroonLng}`);

    // Pattern 1: [lng, lat] - First is in lng range (8-16), second is in lat range (2-13)
    if (a0InCameroonLng && !a0InCameroonLat && b0InCameroonLat && !b0InCameroonLng) {
        logger.info(`✅ DETECTED [lng, lat]: First value in lng range, second in lat range`);
        return 'lng-lat';
    }

    // Pattern 2: [lat, lng] - First is in lat range (2-13), second is in lng range (8-16)
    if (a0InCameroonLat && !a0InCameroonLng && b0InCameroonLng && !b0InCameroonLat) {
        logger.info(`✅ DETECTED [lat, lng]: First value in lat range, second in lng range`);
        return 'lat-lng';
    }

    // ==================== STRATEGY 3: OVERLAP ZONE (8-13) ====================
    // Both lat and lng ranges overlap in 8-13, so use vehicle position scoring

    if ((a0 >= 8 && a0 <= 13) && (b0 >= 8 && b0 <= 13)) {
        logger.warn(`⚠️ AMBIGUOUS: Both values in overlap zone [8-13]`);

        // Use vehicle position to score
        if (currentLat && currentLng) {
            // Calculate all points to get better average distance
            const scoreLatLng = coordinates.reduce((sum, [a, b]) => {
                return sum + Math.abs(a - currentLat) + Math.abs(b - currentLng);
            }, 0);

            const scoreLngLat = coordinates.reduce((sum, [a, b]) => {
                return sum + Math.abs(a - currentLng) + Math.abs(b - currentLat);
            }, 0);

            logger.debug(`📊 Scoring Results:`);
            logger.debug(`   If [lat, lng]: score = ${scoreLatLng.toFixed(4)}`);
            logger.debug(`   If [lng, lat]: score = ${scoreLngLat.toFixed(4)}`);

            if (scoreLngLat < scoreLatLng) {
                logger.info(`✅ DETECTED [lng, lat] by proximity scoring`);
                return 'lng-lat';
            } else {
                logger.info(`✅ DETECTED [lat, lng] by proximity scoring`);
                return 'lat-lng';
            }
        }

        return 'ambiguous';
    }

    // ==================== STRATEGY 4: GENERAL SCORING FALLBACK ====================
    // If we reach here, use general scoring

    if (currentLat && currentLng) {
        const scoreLatLng = coordinates.reduce((sum, [a, b]) => {
            return sum + Math.abs(a - currentLat) + Math.abs(b - currentLng);
        }, 0);

        const scoreLngLat = coordinates.reduce((sum, [a, b]) => {
            return sum + Math.abs(a - currentLng) + Math.abs(b - currentLat);
        }, 0);

        logger.debug(`📊 General Scoring:`);
        logger.debug(`   If [lat, lng]: score = ${scoreLatLng.toFixed(4)}`);
        logger.debug(`   If [lng, lat]: score = ${scoreLngLat.toFixed(4)}`);

        if (scoreLngLat <= scoreLatLng) {
            logger.info(`✅ DETECTED [lng, lat] by general scoring`);
            return 'lng-lat';
        } else {
            logger.info(`✅ DETECTED [lat, lng] by general scoring`);
            return 'lat-lng';
        }
    }

    // ==================== DEFAULT: ASSUME [LAT, LNG] ====================
    logger.warn(`⚠️ Unable to determine format confidently - defaulting to [lat, lng]`);
    return 'lat-lng';
};

/**
 * ✅ ENHANCED: Normalize coordinates to Turf format: [lng, lat]
 * Uses improved detection with Cameroon-specific bounds
 */
const normalizeToLngLat = (zone, lat, lng) => {
    if (!Array.isArray(zone) || zone.length < 3) {
        logger.warn(`⚠️ Invalid zone: must have at least 3 points`);
        return null;
    }

    // Keep only valid coordinate pairs
    const coords = zone
        .filter(
            (c) =>
                Array.isArray(c) &&
                c.length >= 2 &&
                Number.isFinite(Number(c[0])) &&
                Number.isFinite(Number(c[1]))
        )
        .map((c) => [Number(c[0]), Number(c[1])]);

    if (coords.length < 3) {
        logger.warn(`⚠️ After filtering, zone has less than 3 valid points`);
        return null;
    }

    logger.debug(`\n========================================`);
    logger.debug(`🔄 COORDINATE NORMALIZATION`);
    logger.debug(`========================================`);
    logger.debug(`📊 Zone points: ${coords.length}`);

    // Detect format using enhanced detection
    const format = detectCoordinateFormat(coords, lat, lng);

    let normalizedCoords;

    if (format === 'lng-lat') {
        // Already in [lng, lat] format - no conversion needed
        logger.info(`✅ Coordinates already in [lng, lat] format - using as-is`);
        normalizedCoords = coords;
    } else if (format === 'lat-lng') {
        // Need to swap: [lat, lng] → [lng, lat]
        logger.info(`🔄 Converting [lat, lng] → [lng, lat]`);
        normalizedCoords = coords.map(([a, b]) => [b, a]);
    } else {
        // Ambiguous or unknown - use scoring as fallback
        logger.warn(`⚠️ Format detection uncertain - using scoring fallback`);

        if (lat && lng) {
            const scoreLatLng = coords.reduce((sum, [a, b]) => {
                return sum + Math.abs(a - lat) + Math.abs(b - lng);
            }, 0);

            const scoreLngLat = coords.reduce((sum, [a, b]) => {
                return sum + Math.abs(a - lng) + Math.abs(b - lat);
            }, 0);

            if (scoreLngLat <= scoreLatLng) {
                logger.info(`📊 Scoring suggests [lng, lat] - using as-is`);
                normalizedCoords = coords;
            } else {
                logger.info(`📊 Scoring suggests [lat, lng] - converting`);
                normalizedCoords = coords.map(([a, b]) => [b, a]);
            }
        } else {
            // No vehicle position to score against - assume [lat, lng] and convert
            logger.warn(`⚠️ No vehicle position for scoring - assuming [lat, lng] format`);
            normalizedCoords = coords.map(([a, b]) => [b, a]);
        }
    }

    // Validate final coordinates are in valid ranges
    const isValid = normalizedCoords.every(([lng, lat]) => {
        return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    });

    if (!isValid) {
        logger.error(`❌ VALIDATION FAILED: Normalized coordinates contain invalid values!`);
        logger.error(`   This suggests coordinate detection failed`);
        return null;
    }

    logger.debug(`✅ Normalized coordinates validated successfully`);
    logger.debug(`   First point: [${normalizedCoords[0][0]}, ${normalizedCoords[0][1]}] (lng, lat)`);
    logger.debug(`========================================\n`);

    return normalizedCoords;
};

/**
 * Ensure polygon is closed: first point === last point
 */
const closePolygon = (polygonCoords) => {
    if (!polygonCoords || polygonCoords.length < 3) return polygonCoords;

    const first = polygonCoords[0];
    const last = polygonCoords[polygonCoords.length - 1];

    // Check if already closed (with small tolerance for floating point errors)
    const tolerance = 0.000001;
    const isClosed =
        Math.abs(first[0] - last[0]) < tolerance &&
        Math.abs(first[1] - last[1]) < tolerance;

    if (!isClosed) {
        logger.debug(`🔄 Closing polygon (first ≠ last)`);
        return [...polygonCoords, [first[0], first[1]]];
    }

    return polygonCoords;
};

/**
 * ✅ ENHANCED: Check if a point (latitude, longitude) is inside a geofence polygon
 * @param {number} lat - Current latitude
 * @param {number} lng - Current longitude
 * @param {Array|string} geofenceZone - Polygon coords (supports JSON string or array)
 * @returns {boolean} - true if inside, false if outside
 */
const isInsideGeofence = (lat, lng, geofenceZone) => {
    try {
        logger.debug(`\n========================================`);
        logger.debug(`🎯 GEOFENCE POINT-IN-POLYGON CHECK`);
        logger.debug(`========================================`);
        logger.debug(`📍 Vehicle point: [${lat}, ${lng}] (lat, lng)`);

        // ==================== STEP 1: VALIDATE INPUTS ====================
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
            logger.warn("⚠️ Invalid point coordinates (lat/lng). Assuming inside to avoid false alarms.");
            logger.debug(`========================================\n`);
            return true;
        }

        // ==================== STEP 2: PARSE GEOFENCE ZONE ====================
        const zone = parseGeofenceZone(geofenceZone);

        if (!zone || !Array.isArray(zone) || zone.length < 3) {
            logger.warn("⚠️ Invalid geofence zone - polygon must have at least 3 points");
            logger.debug(`========================================\n`);
            return true;
        }

        logger.debug(`📊 Geofence has ${zone.length} points`);
        logger.debug(`📍 First geofence point (raw): [${zone[0]?.[0]}, ${zone[0]?.[1]}]`);

        // ==================== STEP 3: NORMALIZE COORDINATES ====================
        let polygonCoords = normalizeToLngLat(zone, Number(lat), Number(lng));

        if (!polygonCoords || polygonCoords.length < 3) {
            logger.warn("⚠️ Failed to normalize geofence polygon. Assuming inside to avoid false alarms.");
            logger.debug(`========================================\n`);
            return true;
        }

        // ==================== STEP 4: CLOSE POLYGON ====================
        polygonCoords = closePolygon(polygonCoords);

        logger.debug(`📊 Final polygon: ${polygonCoords.length} points (closed)`);
        logger.debug(`📍 First polygon point (normalized): [${polygonCoords[0][0]}, ${polygonCoords[0][1]}] (lng, lat)`);

        // ==================== STEP 5: CREATE TURF OBJECTS ====================
        // Turf expects: point([lng, lat]), polygon([[[lng, lat], ...]])
        const point = turf.point([Number(lng), Number(lat)]);
        const polygon = turf.polygon([polygonCoords]);

        logger.debug(`✅ Turf point: [${lng}, ${lat}] (lng, lat)`);
        logger.debug(`✅ Turf polygon created with ${polygonCoords.length} points`);

        // ==================== STEP 6: PERFORM POINT-IN-POLYGON CHECK ====================
        const inside = turf.booleanPointInPolygon(point, polygon);

        logger.info(`\n🎯 RESULT: Vehicle is ${inside ? '🟢 INSIDE' : '🔴 OUTSIDE'} the geofence`);
        logger.debug(`========================================\n`);

        return inside;

    } catch (error) {
        logger.error(`\n========================================`);
        logger.error(`❌ GEOFENCE CHECK ERROR`);
        logger.error(`========================================`);
        logger.error(`Error message:`, error.message);
        logger.error(`Stack trace:`, error.stack);
        logger.error(`========================================\n`);

        // On error, assume inside to avoid false alarms
        return true;
    }
};

/**
 * ✅ NEW: Validate geofence coordinates before saving
 * Returns: { valid: boolean, format: string, errors: string[] }
 */
const validateGeofenceCoordinates = (coordinates) => {
    const errors = [];

    // Check if array
    if (!Array.isArray(coordinates)) {
        errors.push('Coordinates must be an array');
        return { valid: false, format: 'unknown', errors };
    }

    // Check minimum points
    if (coordinates.length < 3) {
        errors.push('Polygon must have at least 3 points');
        return { valid: false, format: 'unknown', errors };
    }

    // Check if all points are valid
    const validPoints = coordinates.filter(c =>
        Array.isArray(c) &&
        c.length >= 2 &&
        Number.isFinite(Number(c[0])) &&
        Number.isFinite(Number(c[1]))
    );

    if (validPoints.length < 3) {
        errors.push('Not enough valid coordinate pairs');
        return { valid: false, format: 'unknown', errors };
    }

    // Detect format (without vehicle position, use first point only)
    const [a0, b0] = [Number(coordinates[0][0]), Number(coordinates[0][1])];

    let format = 'unknown';

    // Check if values are in valid ranges
    if (Math.abs(a0) > 180 || Math.abs(b0) > 180) {
        errors.push('Coordinate values must be between -180 and 180');
        return { valid: false, format: 'unknown', errors };
    }

    // Detect format based on first point
    if (Math.abs(a0) > 90 && Math.abs(a0) <= 180) {
        format = 'lng-lat';
    } else if (Math.abs(b0) > 90 && Math.abs(b0) <= 180) {
        format = 'lat-lng';
    } else if (a0 >= CAMEROON_BOUNDS.LNG_MIN && a0 <= CAMEROON_BOUNDS.LNG_MAX &&
        b0 >= CAMEROON_BOUNDS.LAT_MIN && b0 <= CAMEROON_BOUNDS.LAT_MAX) {
        format = 'lng-lat';
    } else if (a0 >= CAMEROON_BOUNDS.LAT_MIN && a0 <= CAMEROON_BOUNDS.LAT_MAX &&
        b0 >= CAMEROON_BOUNDS.LNG_MIN && b0 <= CAMEROON_BOUNDS.LNG_MAX) {
        format = 'lat-lng';
    } else {
        format = 'ambiguous';
        errors.push('Cannot determine coordinate format confidently');
    }

    // Check if polygon is closed
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const isClosed = first[0] === last[0] && first[1] === last[1];

    if (!isClosed) {
        // Not an error, just a warning
        logger.debug('ℹ️ Polygon is not closed (will be closed automatically)');
    }

    return {
        valid: errors.length === 0,
        format: format,
        errors: errors,
        pointCount: coordinates.length,
        isClosed: isClosed
    };
};

module.exports = {
    isInsideGeofence,
    validateGeofenceCoordinates,
    normalizeToLngLat,
    detectCoordinateFormat,
    closePolygon,
    CAMEROON_BOUNDS
};