// routes/gpsRoutes.js
const router = require("express").Router();
const {
    issueCommandToVehicle,
    getRealtimeVehicleStatus,
} = require("../controllers/gpsController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

// Issue GPS command (OPENRELAY/CLOSERELAY) — engine control feature
router.post(
    "/gps/issue-command",
    authMiddleware,
    requireFeature(FEATURES.ENGINE_CONTROL),
    issueCommandToVehicle
);

// Get realtime vehicle status — live tracking feature
router.get(
    "/gps/vehicle/:vehicleId/realtime-status",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    getRealtimeVehicleStatus
);

module.exports = router;