// routes/gpsRoutes.js
const router = require("express").Router();
const {
    issueCommandToVehicle,
    getRealtimeVehicleStatus,
} = require("../controllers/gpsController");



// Issue GPS command (OPENRELAY/CLOSERELAY)
router.post("/gps/issue-command", issueCommandToVehicle);

// Get realtime vehicle status from GPS device
router.get("/gps/vehicle/:vehicleId/realtime-status", getRealtimeVehicleStatus);


module.exports = router;