// routes/gpsStatusRoute.js
const express = require("express");
const { getVehicleLocation } = require("../controllers/gpsStatusController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

const router = express.Router();

router.get(
    "/location/:vehicleId",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    getVehicleLocation
);

module.exports = router;