// routes/geofenceRoutes.js
const express = require('express');
const router = express.Router();
const geofenceMonitorController = require('../controllers/geofenceMonitorController');
const authMiddleware = require('../middleware/authMiddleware');
const { requireFeature, FEATURES } = require('../middleware/subscriptionMiddleware');

router.get(
    '/:vehicleId/status',
    authMiddleware,
    requireFeature(FEATURES.GEOFENCE),
    geofenceMonitorController.getGeofenceStatus
);

router.post(
    '/:vehicleId/initialize',
    authMiddleware,
    requireFeature(FEATURES.GEOFENCE),
    geofenceMonitorController.initializeGeofenceStateEndpoint
);

module.exports = router;