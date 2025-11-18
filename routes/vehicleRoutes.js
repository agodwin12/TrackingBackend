const express = require("express");
const router = express.Router();
const vehicleController = require("../controllers/vehicleController");

router.get("/vehicle/:userId", vehicleController.getVehicleDetails);

module.exports = router;
