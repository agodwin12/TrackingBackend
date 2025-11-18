const express = require("express");
const { getUserByVehicleId } = require("../controllers/UserController");

const router = express.Router();

// ✅ Route to fetch user by vehicle ID
router.get("/vehicle/:vehicleId", getUserByVehicleId);

module.exports = router;
