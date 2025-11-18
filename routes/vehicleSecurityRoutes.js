const express = require('express');
const router = express.Router();

const {
    toggleVehicleSecurity,
    getSecurityStatus
} = require('../controllers/vehicleSecurityController');


// ✅ Toggle security ON/OFF with parked location
router.post('/vehicle/:voitureId/security/toggle', (req, res, next) => {
    console.log("📥 API Hit: Toggle Vehicle Security");
    console.log("🔐 Vehicle ID:", req.params.voitureId);
    console.log("📍 Lat:", req.body.latitude, "Lng:", req.body.longitude);
    toggleVehicleSecurity(req, res, next);
});

// ✅ Get current security status
router.get('/vehicle/:voitureId/security/status', (req, res, next) => {
    console.log("📥 API Hit: Get Vehicle Security Status");
    console.log("🔐 Vehicle ID:", req.params.voitureId);
    getSecurityStatus(req, res, next);
});

module.exports = router;
