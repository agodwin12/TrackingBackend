// middleware/geofenceCheckMiddleware.js

const { checkGeofenceViolation } = require('../controllers/geofenceMonitorController');

/**
 * Middleware to check geofence violations after location updates
 * Call this after saving a new location record
 */
const checkGeofenceAfterLocationUpdate = async (vehicleId, latitude, longitude) => {
    try {
        console.log(`🔄 Running geofence check for vehicle ${vehicleId}`);

        // Run geofence check in background (don't block the response)
        setImmediate(async () => {
            try {
                await checkGeofenceViolation(vehicleId, latitude, longitude);
            } catch (error) {
                console.error(`❌ Background geofence check failed for vehicle ${vehicleId}:`, error);
            }
        });

    } catch (error) {
        console.error(`❌ Error in geofence check middleware:`, error);
    }
};

/**
 * Express middleware wrapper for API routes
 * Use this in routes that update vehicle location
 */
const geofenceCheckMiddleware = (req, res, next) => {
    // Store original res.json
    const originalJson = res.json.bind(res);

    // Override res.json to check geofence after response
    res.json = function(data) {
        // Send response first
        originalJson(data);

        // Then check geofence in background
        if (req.vehicleLocationData) {
            const { vehicleId, latitude, longitude } = req.vehicleLocationData;
            checkGeofenceAfterLocationUpdate(vehicleId, latitude, longitude);
        }
    };

    next();
};

module.exports = {
    checkGeofenceAfterLocationUpdate,
    geofenceCheckMiddleware
};