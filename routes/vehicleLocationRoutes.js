// routes/vehicleLocationRoutes.js
const express = require("express");
const { getVehicleLocation } = require("../controllers/vehicleLocationController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

const router = express.Router();

router.get(
    "/location/vehicle/:vehicleId/latest",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    getVehicleLocation
);

// backward-compatible alias
router.get(
    "/location/:vehicleId",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    getVehicleLocation
);

module.exports = router;