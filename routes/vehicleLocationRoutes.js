const express = require("express");
const { getVehicleLocation } = require("../controllers/vehicleLocationController");

const router = express.Router();

// ✅ Route to get vehicle location (updated to match Flutter)
router.get("/location/vehicle/:vehicleId/latest", getVehicleLocation);

// ✅ Keep the old route for backward compatibility if needed
router.get("/location/:vehicleId", getVehicleLocation);

module.exports = router;