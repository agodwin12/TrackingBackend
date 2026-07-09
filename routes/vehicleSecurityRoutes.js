const express = require('express');
const router = express.Router();

const {
    toggleVehicleSecurity,
    getSecurityStatus,
    geofenceUnlock
} = require('../controllers/vehicleSecurityController');
const authMiddleware = require('../middleware/authMiddleware');
const { requireFeature, FEATURES } = require('../middleware/subscriptionMiddleware');

router.post('/vehicle/:voitureId/security/toggle',
    authMiddleware,
    requireFeature(FEATURES.GEOFENCE),
    (req, res, next) => {
        console.log("📥 API Hit: Toggle Vehicle Security");
        console.log("🔐 Vehicle ID:", req.params.voitureId);
        console.log("📍 Lat:", req.body.latitude, "Lng:", req.body.longitude);
        toggleVehicleSecurity(req, res, next);
    }
);

router.get('/vehicle/:voitureId/security/status',
    authMiddleware,
    requireFeature(FEATURES.GEOFENCE),
    (req, res, next) => {
        console.log("📥 API Hit: Get Vehicle Security Status");
        console.log("🔐 Vehicle ID:", req.params.voitureId);
        getSecurityStatus(req, res, next);
    }
);


router.post('/vehicles/:voitureId/geofence-unlock', authMiddleware, geofenceUnlock);

module.exports = router;