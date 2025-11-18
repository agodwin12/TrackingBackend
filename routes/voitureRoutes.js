const express = require("express");
const { getUserVehicles } = require("../controllers/voitureController");
const router = express.Router();

// GET user vehicles by user ID
router.get("/user/:user_id", getUserVehicles);

module.exports = router;
