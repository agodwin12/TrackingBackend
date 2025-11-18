const express = require("express");
const { getVehicleLocation } = require("../controllers/gpsStatusController");

const router = express.Router();

// ✅ Route to get vehicle location
router.get("/location/:vehicleId", getVehicleLocation);

module.exports = router;
