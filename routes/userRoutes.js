const express = require("express");
const { getUserByVehicleId } = require("../controllers/userController");

const router = express.Router();

// ✅ Route to fetch user by vehicle ID
router.get("/vehicle/:vehicleId", getUserByVehicleId);

module.exports = router;
