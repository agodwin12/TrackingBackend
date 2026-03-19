// routes/dashboardVehicleRoutes.js
const express = require("express");
const router = express.Router();
const DashboardVehicleController = require("../controllers/dashboardVehicleController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

router.get(
    "/dashboard/vehicle/:vehicle_id",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    DashboardVehicleController.getVehicleDashboardData
);

module.exports = router;