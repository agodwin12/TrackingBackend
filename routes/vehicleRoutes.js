const express = require("express");
const router = express.Router();
const vehicleController = require("../controllers/vehicleController");

router.get("/vehicle/:userId", vehicleController.getVehicleDetails);

// ✅ CHANGE THIS LINE - add "vehicle/" prefix to match the pattern above
router.get("/vehicle/:vehicleId/engine-status", vehicleController.getEngineStatus);


router.post("/vehicle/:vehicleId/force-gps-update", vehicleController.forceGPSUpdate);

module.exports = router;