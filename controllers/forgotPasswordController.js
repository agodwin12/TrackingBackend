// controllers/forgotPasswordController.js

const bcrypt          = require('bcryptjs');
const axios           = require('axios');
const User            = require('../models/userModel');
const keycloakService = require('../services/keycloakService');
const logger          = require('../utils/logger');

// ── OTP store (use Redis in production for multi-instance safety) ─────────────
const otpStore = new Map();
const OTP_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes

// ── SMS config ────────────────────────────────────────────────────────────────
const SMS_API_TOKEN = process.env.TECHSOFT_SMS_API_TOKEN;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'PROXYM';

if (!SMS_API_TOKEN) {
    throw new Error(
        '❌ FATAL: TECHSOFT_SMS_API_TOKEN is not set. ' +
        'Add it to your .env file before starting the server.'
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePhoneForDB(phone) {
    if (!phone) return null;

    const cleaned = phone.trim();

    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function normalizePhoneForSMS(phone) {
    if (!phone) return null;

    return phone.trim().replace(/^\+/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP generator
// ─────────────────────────────────────────────────────────────────────────────

function generateOTP() {
    const first  = Math.floor(100 + Math.random() * 900);
    const second = Math.floor(100 + Math.random() * 900);

    return `${first}-${second}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS sender
// ─────────────────────────────────────────────────────────────────────────────

async function sendOTPViaSMS(phoneWithoutPlus, otp) {
    const apiUrl = 'https://app.techsoft-sms.com/api/http/sms/send/';

    const payload = {
        api_token: SMS_API_TOKEN,
        recipient: phoneWithoutPlus,
        sender_id: SMS_SENDER_ID,
        type: 'plain',
        message: `Your PROXYM TRACKING password reset OTP is: ${otp}. Valid for 5 minutes.`,
    };

    logger.info(`📤 [ForgotPassword] Sending SMS to ${phoneWithoutPlus}`);

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            timeout: 15000,
            validateStatus: () => true,
        });

        if (response.status >= 200 && response.status < 300) {
            return {
                success: true,
                data: response.data,
            };
        }

        logger.error(
            `❌ [ForgotPassword] SMS API error ${response.status}:`,
            response.data
        );

        return {
            success: false,
            error: {
                status: response.status,
                data: response.data,
            },
        };

    } catch (err) {
        logger.error('❌ [ForgotPassword] SMS request failed:', err.message);

        return {
            success: false,
            error: {
                type: err.code,
                message: err.message,
            },
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keycloak password sync
//
// IMPORTANT:
// For forgot-password reset, Keycloak sync must be REQUIRED.
// If Keycloak fails, we must NOT return success, because Keycloak is the real
// authentication source used by login.
// ─────────────────────────────────────────────────────────────────────────────

async function syncKeycloakPasswordRequired(user, newPassword) {
    if (!user.keycloak_id) {
        throw new Error(
            `User ${user.id} has no keycloak_id — cannot sync password to Keycloak`
        );
    }

    await keycloakService.resetKeycloakPassword(user.keycloak_id, newPassword);

    logger.info(
        `✅ [ForgotPassword] Keycloak password synced for user ${user.id}`
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1 — REQUEST OTP
// POST /api/auth/forgot-password/request-otp
// ═════════════════════════════════════════════════════════════════════════════

exports.requestOTP = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required',
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);

        const user = await User.findOne({
            where: { phone: phoneWithPlus },
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'No account found with this phone number',
            });
        }

        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        logger.info(
            `📲 [ForgotPassword] OTP generated for user ${user.id} — sending via SMS`
        );

        otpStore.set(phoneWithPlus, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0,
        });

        const smsResult = await sendOTPViaSMS(
            normalizePhoneForSMS(phoneWithPlus),
            otp
        );

        if (!smsResult.success) {
            otpStore.delete(phoneWithPlus);

            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again.',
            });
        }

        logger.info(`✅ [ForgotPassword] OTP sent to user ${user.id}`);

        return res.json({
            success: true,
            message: 'OTP sent successfully to your phone',
            phone: phoneWithPlus,
            expiresIn: 300,
        });

    } catch (err) {
        logger.error('🔥 [ForgotPassword] requestOTP error:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// STEP 2 — VERIFY OTP
// POST /api/auth/forgot-password/verify-otp
// ═════════════════════════════════════════════════════════════════════════════

exports.verifyOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Phone and OTP are required',
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);
        const storedOTPData = otpStore.get(phoneWithPlus);

        if (!storedOTPData) {
            return res.status(404).json({
                success: false,
                message: 'No OTP request found. Please request a new OTP.',
            });
        }

        if (Date.now() > storedOTPData.expiryTime) {
            otpStore.delete(phoneWithPlus);

            return res.status(400).json({
                success: false,
                message: 'OTP has expired. Please request a new one.',
            });
        }

        if (storedOTPData.attempts >= 3) {
            otpStore.delete(phoneWithPlus);

            return res.status(400).json({
                success: false,
                message: 'Too many failed attempts. Please request a new OTP.',
            });
        }

        if (storedOTPData.otp !== otp) {
            storedOTPData.attempts += 1;

            otpStore.set(phoneWithPlus, storedOTPData);

            return res.status(400).json({
                success: false,
                message: `Invalid OTP. ${3 - storedOTPData.attempts} attempts remaining.`,
            });
        }

        logger.info(
            `✅ [ForgotPassword] OTP verified for user ${storedOTPData.userId}`
        );

        const resetToken =
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        const resetTokenExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

        otpStore.set(`reset_${phoneWithPlus}`, {
            token: resetToken,
            expiryTime: resetTokenExpiry,
            userId: storedOTPData.userId,
        });

        otpStore.delete(phoneWithPlus);

        return res.json({
            success: true,
            message: 'OTP verified successfully',
            resetToken,
            phone: phoneWithPlus,
            userId: storedOTPData.userId,
        });

    } catch (err) {
        logger.error('🔥 [ForgotPassword] verifyOTP error:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// STEP 3 — RESET PASSWORD
// POST /api/auth/forgot-password/reset-password
// ═════════════════════════════════════════════════════════════════════════════

exports.resetPassword = async (req, res) => {
    try {
        const { phone, resetToken, newPassword } = req.body;

        if (!phone || !resetToken || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Phone, reset token, and new password are required',
            });
        }

        // Keep this aligned with Keycloak password policy.
        // Your partner password change already uses 8 characters.
        if (newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters',
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);
        const resetData = otpStore.get(`reset_${phoneWithPlus}`);

        if (!resetData) {
            return res.status(404).json({
                success: false,
                message: 'Invalid or expired reset session. Please start over.',
            });
        }

        if (resetData.token !== resetToken) {
            return res.status(400).json({
                success: false,
                message: 'Invalid reset token',
            });
        }

        if (Date.now() > resetData.expiryTime) {
            otpStore.delete(`reset_${phoneWithPlus}`);

            return res.status(400).json({
                success: false,
                message: 'Reset session expired. Please start over.',
            });
        }

        const user = await User.findByPk(resetData.userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        // ── Step 1: update Keycloak first ────────────────────────────────────
        // If this fails, we stop here and do NOT update MySQL.
        // This avoids returning success while Keycloak still has the old password.
        try {
            await syncKeycloakPasswordRequired(user, newPassword);
        } catch (keycloakError) {
            logger.error(
                `❌ [ForgotPassword] Keycloak password reset failed for user ${user.id}: ${keycloakError.message}`
            );

            return res.status(500).json({
                success: false,
                message: 'Unable to update authentication password. Please contact support.',
            });
        }

        // ── Step 2: update MySQL only after Keycloak succeeds ────────────────
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await user.update({
            password: hashedPassword,
            is_first_login: false,
        });

        logger.info(
            `✅ [ForgotPassword] MySQL password reset for user ${user.id}`
        );

        otpStore.delete(`reset_${phoneWithPlus}`);

        return res.json({
            success: true,
            message: 'Password reset successfully. You can now login with your new password.',
            phone: phoneWithPlus,
        });

    } catch (err) {
        logger.error('🔥 [ForgotPassword] resetPassword error:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// RESEND OTP
// POST /api/auth/forgot-password/resend-otp
// ═════════════════════════════════════════════════════════════════════════════

exports.resendOTP = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required',
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);

        const user = await User.findOne({
            where: { phone: phoneWithPlus },
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'No account found with this phone number',
            });
        }

        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        logger.info(
            `📲 [ForgotPassword] New OTP generated for user ${user.id} — sending via SMS`
        );

        otpStore.set(phoneWithPlus, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0,
        });

        const smsResult = await sendOTPViaSMS(
            normalizePhoneForSMS(phoneWithPlus),
            otp
        );

        if (!smsResult.success) {
            otpStore.delete(phoneWithPlus);

            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again.',
            });
        }

        logger.info(`✅ [ForgotPassword] OTP resent to user ${user.id}`);

        return res.json({
            success: true,
            message: 'New OTP sent successfully',
            phone: phoneWithPlus,
            expiresIn: 300,
        });

    } catch (err) {
        logger.error('🔥 [ForgotPassword] resendOTP error:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

module.exports = exports;