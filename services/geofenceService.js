// services/geofenceService.js

const turf = require('@turf/turf');

/**
 * Check if a point (latitude, longitude) is inside a geofence polygon
 * @param {number} lat - Current latitude
 * @param {number} lng - Current longitude
 * @param {Array} geofenceZone - Array of coordinates defining the polygon (auto-detects [lat, lng] or [lng, lat] format)
 * @returns {boolean} - true if inside, false if outside
 */
const isInsideGeofence = (lat, lng, geofenceZone) => {
    try {
        console.log(`🔍 Checking if point [${lat}, ${lng}] is inside geofence...`);

        // Validate input
        if (!geofenceZone || !Array.isArray(geofenceZone) || geofenceZone.length < 3) {
            console.warn('⚠️ Invalid geofence zone data - polygon must have at least 3 points');
            return true; // If no valid geofence, assume inside to avoid false alarms
        }

        console.log(`📐 Geofence has ${geofenceZone.length} points`);

        // Create a point from current location [lng, lat] for turf
        const point = turf.point([lng, lat]);

        // ✅ AUTO-DETECT FORMAT: Check if coordinates are [lng, lat] or [lat, lng]
        // Longitude ranges: -180 to 180
        // Latitude ranges: -90 to 90
        const firstCoord = geofenceZone[0];
        let polygonCoords;

        console.log(`🔍 First coordinate in geofence: [${firstCoord[0]}, ${firstCoord[1]}]`);

        // If first value is > 90 or < -90, it's longitude (so format is [lng, lat])
        if (Math.abs(firstCoord[0]) > 90) {
            console.log('✅ Detected [lng, lat] format in geofence data (no conversion needed)');
            // Already in correct [lng, lat] format for turf
            polygonCoords = geofenceZone.map(coord => [coord[0], coord[1]]);
        } else {
            console.log('✅ Detected [lat, lng] format - converting to [lng, lat] for turf');
            // Convert from [lat, lng] to [lng, lat]
            polygonCoords = geofenceZone.map(coord => [coord[1], coord[0]]);
        }

        // Ensure polygon is closed (first point === last point)
        const first = polygonCoords[0];
        const last = polygonCoords[polygonCoords.length - 1];

        if (first[0] !== last[0] || first[1] !== last[1]) {
            polygonCoords.push([first[0], first[1]]);
            console.log('✅ Closed polygon by adding first point at end');
        } else {
            console.log('✅ Polygon is already closed');
        }

        console.log(`📐 Final polygon has ${polygonCoords.length} points`);

        // Create turf polygon
        const polygon = turf.polygon([polygonCoords]);

        // Check if point is inside polygon
        const inside = turf.booleanPointInPolygon(point, polygon);

        console.log(`📍 Result: Point [lat: ${lat}, lng: ${lng}] is ${inside ? '✅ INSIDE' : '❌ OUTSIDE'} the geofence polygon`);

        return inside;

    } catch (error) {
        console.error('❌ Error checking geofence:', error);
        console.error('❌ Error stack:', error.stack);
        return true; // On error, assume inside to avoid false alarms
    }
};

module.exports = {
    isInsideGeofence
};
