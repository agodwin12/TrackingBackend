const express = require("express");
const { changePasswordByVehicleId } = require("../controllers/ChangePasswordController");

const router = express.Router();

// ✅ Route to change password using vehicle ID
router.post("/change-password", changePasswordByVehicleId);

module.exports = router;
