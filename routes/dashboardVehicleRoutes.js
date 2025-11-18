const express = require("express");
const router = express.Router();
const DashboardVehicleController = require("../controllers/dashboardVehicleController");

router.get("/dashboard/vehicle/:vehicle_id", DashboardVehicleController.getVehicleDashboardData);

module.exports = router;
