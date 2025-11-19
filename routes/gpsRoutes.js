// routes/gps.js
const router = require("express").Router();
const {
    issueCommandToVehicle,
    getRealtimeVehicleStatus,
} = require("../controllers/gpsController");


router.post("/gps/issue-command", issueCommandToVehicle);


router.get("/gps/vehicle/:vehicleId/realtime-status", getRealtimeVehicleStatus);

module.exports = router;