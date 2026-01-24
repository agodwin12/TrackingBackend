// routes/geofenceRoutes.js

const express = require('express');
const router = express.Router();
const geofenceMonitorController = require('../controllers/geofenceMonitorController');
const authMiddleware = require('../middleware/authMiddleware');


router.get('/:vehicleId/status', authMiddleware, geofenceMonitorController.getGeofenceStatus);


router.post('/:vehicleId/initialize', authMiddleware, geofenceMonitorController.initializeGeofenceStateEndpoint);

module.exports = router;