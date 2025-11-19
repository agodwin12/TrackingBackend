const express = require("express");
const ChangePasswordController = require("../controllers/changePasswordController");
const { changePasswordByVehicleId, setPasswordFirstLogin } = require("../controllers/changePasswordController");

const router = express.Router();

// 🆕 Set Password (for first-time login or password reset)
router.post("/users/set-password", ChangePasswordController.setPassword);

// If you also want the first login specific endpoint:
router.post("/users/set-password-first-login", ChangePasswordController.setPasswordFirstLogin);

// Existing change password route (uses vehicle ID)
router.post("/password/users/change-password", ChangePasswordController.changePasswordByVehicleId);


// 🆕 Route to set password for first-time login (no old password required)
router.post("/set-password", setPasswordFirstLogin);


module.exports = router;