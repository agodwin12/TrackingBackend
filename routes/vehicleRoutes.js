// routes/vehicleRoutes.js
const express = require("express");
const router = express.Router();
const vehicleController = require("../controllers/vehicleController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

// Base vehicle details — no feature gate, all subscribers can see their vehicle
router.get("/vehicle/:userId", authMiddleware, vehicleController.getVehicleDetails);

// Engine status — requires engine control feature
router.get(
    "/vehicle/:vehicleId/engine-status",
    authMiddleware,
    requireFeature(FEATURES.ENGINE_CONTROL),
    vehicleController.getEngineStatus
);

// Force GPS update — requires live tracking feature
router.post(
    "/vehicle/:vehicleId/force-gps-update",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    vehicleController.forceGPSUpdate
);

module.exports = router;