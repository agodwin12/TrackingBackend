// routes/ChangePasswordRoutes.js
const express                  = require('express');
const ChangePasswordController = require('../controllers/changePasswordController');
const ForgotPasswordController = require('../controllers/forgotPasswordController');
const authMiddleware           = require('../middleware/authMiddleware');

const router = express.Router();

// ── Existing password routes (tracking app users) ─────────────────────────────
router.post('/users/set-password',             ChangePasswordController.setPassword);
router.post('/users/set-password-first-login', ChangePasswordController.setPasswordFirstLogin);
router.post('/set-password',                   ChangePasswordController.setPasswordFirstLogin);
router.post('/password/users/change-password', ChangePasswordController.changePasswordByVehicleId);

// ── Forgot password (OTP-based) ───────────────────────────────────────────────
router.post('/auth/forgot-password/request-otp',  ForgotPasswordController.requestOTP);
router.post('/auth/forgot-password/verify-otp',   ForgotPasswordController.verifyOTP);
router.post('/auth/forgot-password/reset-password', ForgotPasswordController.resetPassword);
router.post('/auth/forgot-password/resend-otp',   ForgotPasswordController.resendOTP);

// ── Recouvrement / partner routes (Keycloak-authenticated) ───────────────────
// PUT /api/partner/change-password  { currentPassword, newPassword }
router.put('/partner/change-password', authMiddleware, ChangePasswordController.changePasswordPartner);

// POST /api/partner/logout  { refreshToken }
router.post('/partner/logout', authMiddleware, ChangePasswordController.logoutPartner);

module.exports = router;