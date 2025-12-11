// routes/ChangePasswordRoutes.js

const express = require("express");
const ChangePasswordController = require("../controllers/changePasswordController");
const ForgotPasswordController = require("../controllers/forgotPasswordController");

const router = express.Router();

// ========================================
// 🔒 CHANGE PASSWORD ROUTES
// ========================================

// Set Password (for first-time login or password reset)
router.post("/users/set-password", ChangePasswordController.setPassword);

// Set Password for first login (no old password required)
router.post("/users/set-password-first-login", ChangePasswordController.setPasswordFirstLogin);

// Alternative route for first login
router.post("/set-password", ChangePasswordController.setPasswordFirstLogin);

// Change password using vehicle ID (existing functionality)
router.post("/password/users/change-password", ChangePasswordController.changePasswordByVehicleId);


// ========================================
// 📱 FORGOT PASSWORD ROUTES (OTP-based)
// ========================================

// Step 1: Request OTP for password reset
router.post("/auth/forgot-password/request-otp", ForgotPasswordController.requestOTP);

// Step 2: Verify OTP code
router.post("/auth/forgot-password/verify-otp", ForgotPasswordController.verifyOTP);

// Step 3: Reset password with verified token
router.post("/auth/forgot-password/reset-password", ForgotPasswordController.resetPassword);

// Optional: Resend OTP if expired or not received
router.post("/auth/forgot-password/resend-otp", ForgotPasswordController.resendOTP);


module.exports = router;