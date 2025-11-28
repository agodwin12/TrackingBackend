// routes/geofenceRoutes.js

const express = require('express');
const router = express.Router();
const { getGeofenceStatus } = require('../controllers/geofenceMonitorController');
const authMiddleware = require('../middleware/authMiddleware');


router.get('/:vehicleId/status', authMiddleware, getGeofenceStatus);

module.exports = router;