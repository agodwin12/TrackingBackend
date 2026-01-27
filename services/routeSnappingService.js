// services/routeSnappingService.js - SNAP GPS POINTS TO ROADS
const axios = require('axios');
const logger = require('../utils/logger');

class RouteSnappingService {
    // ==================== CONFIGURATION ====================

    // Free OSRM server (you can self-host for better performance)
    static OSRM_SERVER = process.env.OSRM_SERVER || 'https://router.project-osrm.org';

    // Maximum waypoints per request (OSRM limit is ~100)
    static MAX_WAYPOINTS_PER_REQUEST = 100;

    // Timeout for API requests
    static TIMEOUT_MS = 10000; // 10 seconds

    // ==================== MAIN FUNCTIONS ====================

    /**
     * Snap GPS waypoints to actual roads
     * Returns an array of coordinates that follow the road network
     *
     * @param {Array} waypoints - Array of {latitude, longitude} objects
     * @returns {Promise<Array>} - Array of road-following coordinates
     */
    static async snapToRoads(waypoints) {
        try {
            if (!waypoints || waypoints.length < 2) {
                logger.warn('⚠️ Not enough waypoints to snap to roads');
                return waypoints;
            }

            logger.info(`📍 Snapping ${waypoints.length} waypoints to roads...`);

            // If too many waypoints, sample them first
            let sampledWaypoints = waypoints;
            if (waypoints.length > this.MAX_WAYPOINTS_PER_REQUEST) {
                sampledWaypoints = this.sampleWaypoints(waypoints, this.MAX_WAYPOINTS_PER_REQUEST);
                logger.info(`📊 Sampled to ${sampledWaypoints.length} waypoints for routing`);
            }

            // Build OSRM request URL
            const coordinates = sampledWaypoints
                .map(w => `${w.longitude},${w.latitude}`)
                .join(';');

            const url = `${this.OSRM_SERVER}/route/v1/driving/${coordinates}?overview=full&geometries=geojson`;

            logger.debug(`🔗 OSRM Request: ${url.substring(0, 100)}...`);

            // Make request to OSRM
            const response = await axios.get(url, {
                timeout: this.TIMEOUT_MS,
                headers: {
                    'User-Agent': 'PROXYM-Tracking/1.0'
                }
            });

            if (response.data.code !== 'Ok') {
                logger.error(`❌ OSRM error: ${response.data.code}`);
                return waypoints; // Fallback to original waypoints
            }

            // Extract road-following coordinates from response
            const roadCoordinates = response.data.routes[0].geometry.coordinates;

            // Convert from [lng, lat] to {latitude, longitude}
            const snappedRoute = roadCoordinates.map(coord => ({
                latitude: coord[1],
                longitude: coord[0]
            }));

            logger.info(`✅ Snapped route: ${waypoints.length} GPS points → ${snappedRoute.length} road points`);

            return snappedRoute;

        } catch (error) {
            logger.error('🔥 Error snapping to roads:', error.message);
            // Fallback to original waypoints if snapping fails
            return waypoints;
        }
    }

    /**
     * Get route geometry between two points
     * Useful for drawing routes between start and end locations
     */
    static async getRouteBetweenPoints(startLat, startLon, endLat, endLon) {
        try {
            const url = `${this.OSRM_SERVER}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson`;

            const response = await axios.get(url, {
                timeout: this.TIMEOUT_MS,
                headers: {
                    'User-Agent': 'PROXYM-Tracking/1.0'
                }
            });

            if (response.data.code !== 'Ok') {
                return null;
            }

            const roadCoordinates = response.data.routes[0].geometry.coordinates;

            return roadCoordinates.map(coord => ({
                latitude: coord[1],
                longitude: coord[0]
            }));

        } catch (error) {
            logger.error('🔥 Error getting route:', error.message);
            return null;
        }
    }

    /**
     * Match GPS trace to road network
     * Better for continuous GPS tracking with noise
     */
    static async matchToRoads(waypoints) {
        try {
            if (!waypoints || waypoints.length < 2) {
                return waypoints;
            }

            logger.info(`📍 Matching ${waypoints.length} waypoints to roads...`);

            // Sample if needed
            let sampledWaypoints = waypoints;
            if (waypoints.length > this.MAX_WAYPOINTS_PER_REQUEST) {
                sampledWaypoints = this.sampleWaypoints(waypoints, this.MAX_WAYPOINTS_PER_REQUEST);
            }

            const coordinates = sampledWaypoints
                .map(w => `${w.longitude},${w.latitude}`)
                .join(';');

            // Use match service instead of route service
            const url = `${this.OSRM_SERVER}/match/v1/driving/${coordinates}?overview=full&geometries=geojson`;

            const response = await axios.get(url, {
                timeout: this.TIMEOUT_MS,
                headers: {
                    'User-Agent': 'PROXYM-Tracking/1.0'
                }
            });

            if (response.data.code !== 'Ok' || !response.data.matchings[0]) {
                logger.warn('⚠️ Road matching failed, using route instead');
                return this.snapToRoads(waypoints);
            }

            const roadCoordinates = response.data.matchings[0].geometry.coordinates;

            const matchedRoute = roadCoordinates.map(coord => ({
                latitude: coord[1],
                longitude: coord[0]
            }));

            logger.info(`✅ Matched route: ${waypoints.length} GPS points → ${matchedRoute.length} road points`);

            return matchedRoute;

        } catch (error) {
            logger.error('🔥 Error matching to roads:', error.message);
            // Fallback to snap if match fails
            return this.snapToRoads(waypoints);
        }
    }

    /**
     * Sample waypoints uniformly
     * Keeps first, last, and evenly distributed points
     */
    static sampleWaypoints(waypoints, maxPoints) {
        if (waypoints.length <= maxPoints) {
            return waypoints;
        }

        const sampled = [];
        sampled.push(waypoints[0]); // Always keep first

        const step = Math.floor(waypoints.length / (maxPoints - 1));

        for (let i = step; i < waypoints.length - 1; i += step) {
            sampled.push(waypoints[i]);
        }

        sampled.push(waypoints[waypoints.length - 1]); // Always keep last

        return sampled;
    }

    /**
     * Decode polyline string to coordinates
     * Used if you have encoded polylines
     */
    static decodePolyline(encoded) {
        const points = [];
        let index = 0;
        let lat = 0;
        let lng = 0;

        while (index < encoded.length) {
            let shift = 0;
            let result = 0;
            let byte;

            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);

            const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += dlat;

            shift = 0;
            result = 0;

            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);

            const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lng += dlng;

            points.push({
                latitude: lat / 1e5,
                longitude: lng / 1e5
            });
        }

        return points;
    }

    /**
     * Check if OSRM server is available
     */
    static async checkServerAvailability() {
        try {
            const response = await axios.get(`${this.OSRM_SERVER}/route/v1/driving/0,0;1,1`, {
                timeout: 5000
            });
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }
}

module.exports = RouteSnappingService;