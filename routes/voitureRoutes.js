const express = require("express");
const { getUserVehicles, updateVehicleNickname } = require("../controllers/voitureController");
const router = express.Router();

// GET user vehicles by user ID
router.get("/voitures/user/:user_id", getUserVehicles);


router.put("/vehicles/:vehicleId/nickname", updateVehicleNickname);


module.exports = router;
