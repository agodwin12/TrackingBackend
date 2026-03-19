// controllers/forgotPasswordController.js

const bcrypt = require("bcryptjs");
const axios = require("axios");
const User = require("../models/userModel");

// Store OTPs temporarily (in production, use Redis for better scalability)
const otpStore = new Map();

// OTP expiration time (5 minutes)
const OTP_EXPIRY_TIME = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════
// SMS API CONFIG — loaded from environment variables only
// Required: TECHSOFT_SMS_API_TOKEN must be set in your .env file
// ═══════════════════════════════════════════════════════════════════════
const SMS_API_TOKEN = process.env.TECHSOFT_SMS_API_TOKEN;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || "PROXYM";

if (!SMS_API_TOKEN) {
    throw new Error(
        "❌ FATAL: TECHSOFT_SMS_API_TOKEN is not set. " +
        "Add it to your .env file before starting the server."
    );
}

// ═══════════════════════════════════════════════════════════════════════
// PHONE NUMBER UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Normalize phone for database (always with + prefix)
 * Database stores: +237673927172
 */
function normalizePhoneForDB(phone) {
    if (!phone) return null;
    const cleaned = phone.trim();
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

/**
 * Normalize phone for SMS API (always without + prefix)
 * SMS API requires: 237673927172
 */
function normalizePhoneForSMS(phone) {
    if (!phone) return null;
    return phone.trim().replace(/^\+/, '');
}

// ═══════════════════════════════════════════════════════════════════════
// OTP GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
    const first = Math.floor(100 + Math.random() * 900);
    const second = Math.floor(100 + Math.random() * 900);
    return `${first}-${second}`;
}

// ═══════════════════════════════════════════════════════════════════════
// SMS SENDING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Send OTP via Techsoft SMS API
 * API Documentation: https://app.techsoftsms.com/api/http/sms/send
 *
 * @param {string} phoneWithoutPlus - Phone number WITHOUT + prefix (e.g., 237673927172)
 * @param {string} otp - The OTP code to send
 */
async function sendOTPViaSMS(phoneWithoutPlus, otp) {
    const apiUrl = "https://app.techsoft-sms.com/api/http/sms/send/";
    const payload = {
        api_token: SMS_API_TOKEN,   // ✅ FIXED: loaded from environment variable
        recipient: phoneWithoutPlus,
        sender_id: SMS_SENDER_ID,
        type: "plain",
        message: `Your PROXYM TRACKING password reset OTP is: ${otp}. Valid for 5 minutes.`
    };

    console.log("📤 Sending SMS to:", phoneWithoutPlus, "(verified no + prefix)");

    try {
        console.log("⏱️  Request started at:", new Date().toISOString());

        const startTime = Date.now();

        const response = await axios.post(
            apiUrl,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000,
                validateStatus: function (status) {
                    return true;
                }
            }
        );

        const duration = Date.now() - startTime;
        console.log("⏱️  Request completed in:", duration, "ms");

        if (response.status >= 200 && response.status < 300) {
            console.log("✅ SMS API CALL SUCCESSFUL!");
            return { success: true, data: response.data };
        } else {
            console.error("❌ SMS API RETURNED ERROR STATUS!", response.status);
            return {
                success: false,
                error: {
                    status: response.status,
                    message: response.data?.message || response.statusText,
                    data: response.data
                }
            };
        }

    } catch (error) {
        console.error("┌─────────────────────────────────────────");
        console.error("│ ❌ SMS API ERROR");

        if (error.code) {
            console.error("│ ERROR CODE:", error.code);

            switch (error.code) {
                case 'ENOTFOUND':
                    console.error("│ 🌐 DNS LOOKUP FAILED");
                    console.error("│ Cannot resolve: app.techsoftsms.com");
                    console.error("│ Troubleshooting:");
                    console.error("│   1. Check internet connection");
                    console.error("│   2. Try: ping app.techsoftsms.com");
                    console.error("│   3. Check firewall/DNS settings");
                    break;
                case 'ETIMEDOUT':
                    console.error("│ ⏱️  CONNECTION TIMEOUT");
                    break;
                case 'ECONNREFUSED':
                    console.error("│ 🚫 CONNECTION REFUSED");
                    break;
            }
        }

        if (error.response) {
            console.error("│ HTTP Response Error");
            console.error("│ Status:", error.response.status);
        } else if (error.request) {
            console.error("│ NO RESPONSE RECEIVED");
        }

        console.error("└─────────────────────────────────────────\n");

        return {
            success: false,
            error: {
                type: error.code || error.name,
                message: error.message
            }
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 1: REQUEST OTP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Step 1: Request OTP for password reset
 * POST /api/auth/forgot-password/request-otp
 */
exports.requestOTP = async (req, res) => {
    try {
        console.log("\n📥 [FORGOT-PASSWORD] Request OTP received");

        const { phone } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: "Phone number is required"
            });
        }

        // ✅ Add + prefix for database lookup
        const phoneWithPlus = normalizePhoneForDB(phone);

        // =============================
        // 2️⃣ CHECK IF USER EXISTS
        // =============================
        const user = await User.findOne({ where: { phone: phoneWithPlus } });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "No account found with this phone number"
            });
        }

        // =============================
        // 3️⃣ GENERATE OTP
        // =============================
        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        // ✅ FIXED: OTP is NOT logged — it is only sent via SMS
        console.log(`📲 OTP generated for user ${user.id} — sending via SMS...`);

        // Store OTP with phone (with + prefix)
        otpStore.set(phoneWithPlus, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0
        });

        // =============================
        // 4️⃣ SEND OTP VIA SMS
        // =============================
        const phoneWithoutPlus = normalizePhoneForSMS(phoneWithPlus);

        const smsResult = await sendOTPViaSMS(phoneWithoutPlus, otp);

        if (!smsResult.success) {
            // Clean up stored OTP if SMS failed
            otpStore.delete(phoneWithPlus);
            console.error("❌ Failed to send SMS:", smsResult.error);
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log(`✅ OTP sent successfully to user ${user.id}`);

        // =============================
        // 5️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP sent successfully to your phone",
            phone: phoneWithPlus,
            expiresIn: 300 // 5 minutes in seconds
        });

    } catch (error) {
        console.error("🔥 ERROR in requestOTP:", error.message);
        return res.status(500).json({
            success: false,
            message: "Server error. Please try again later."
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// STEP 2: VERIFY OTP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Step 2: Verify OTP
 * POST /api/auth/forgot-password/verify-otp
 */
exports.verifyOTP = async (req, res) => {
    try {
        console.log("\n📥 [VERIFY-OTP] Request received");

        const { phone, otp } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone || !otp) {
            return res.status(400).json({
                success: false,
                message: "Phone and OTP are required"
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);

        // =============================
        // 2️⃣ CHECK IF OTP EXISTS
        // =============================
        const storedOTPData = otpStore.get(phoneWithPlus);

        if (!storedOTPData) {
            return res.status(404).json({
                success: false,
                message: "No OTP request found. Please request a new OTP."
            });
        }

        // =============================
        // 3️⃣ CHECK OTP EXPIRY
        // =============================
        if (Date.now() > storedOTPData.expiryTime) {
            otpStore.delete(phoneWithPlus);
            return res.status(400).json({
                success: false,
                message: "OTP has expired. Please request a new one."
            });
        }

        // =============================
        // 4️⃣ CHECK ATTEMPT LIMIT
        // =============================
        if (storedOTPData.attempts >= 3) {
            otpStore.delete(phoneWithPlus);
            return res.status(400).json({
                success: false,
                message: "Too many failed attempts. Please request a new OTP."
            });
        }

        // =============================
        // 5️⃣ VERIFY OTP
        // =============================
        if (storedOTPData.otp !== otp) {
            storedOTPData.attempts += 1;
            otpStore.set(phoneWithPlus, storedOTPData);

            return res.status(400).json({
                success: false,
                message: `Invalid OTP. ${3 - storedOTPData.attempts} attempts remaining.`
            });
        }

        console.log(`✅ OTP verified for user ${storedOTPData.userId}`);

        // =============================
        // 6️⃣ GENERATE RESET TOKEN
        // =============================
        // Create a temporary reset token (valid for 10 minutes)
        const resetToken = Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        const resetTokenExpiry = Date.now() + (10 * 60 * 1000); // 10 minutes

        // Store reset token, delete OTP
        otpStore.set(`reset_${phoneWithPlus}`, {
            token: resetToken,
            expiryTime: resetTokenExpiry,
            userId: storedOTPData.userId
        });

        otpStore.delete(phoneWithPlus);

        console.log(`🔑 Reset token generated for user ${storedOTPData.userId}`);

        // =============================
        // 7️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP verified successfully",
            resetToken,
            phone: phoneWithPlus,
            userId: storedOTPData.userId
        });

    } catch (error) {
        console.error("🔥 ERROR in verifyOTP:", error.message);
        return res.status(500).json({
            success: false,
            message: "Server error. Please try again later."
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// STEP 3: RESET PASSWORD
// ═══════════════════════════════════════════════════════════════════════

/**
 * Step 3: Reset password with verified token
 * POST /api/auth/forgot-password/reset-password
 */
exports.resetPassword = async (req, res) => {
    try {
        console.log("\n📥 [RESET-PASSWORD] Request received");

        const { phone, resetToken, newPassword } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone || !resetToken || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "Phone, reset token, and new password are required"
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);

        // =============================
        // 2️⃣ VERIFY RESET TOKEN
        // =============================
        const resetData = otpStore.get(`reset_${phoneWithPlus}`);

        if (!resetData) {
            return res.status(404).json({
                success: false,
                message: "Invalid or expired reset session. Please start over."
            });
        }

        if (resetData.token !== resetToken) {
            return res.status(400).json({
                success: false,
                message: "Invalid reset token"
            });
        }

        if (Date.now() > resetData.expiryTime) {
            otpStore.delete(`reset_${phoneWithPlus}`);
            return res.status(400).json({
                success: false,
                message: "Reset session expired. Please start over."
            });
        }

        // =============================
        // 3️⃣ FETCH USER
        // =============================
        const user = await User.findByPk(resetData.userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // =============================
        // 4️⃣ HASH & UPDATE PASSWORD
        // =============================
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await user.update({
            password: hashedPassword,
            is_first_login: false
        });

        console.log(`✅ Password reset successfully for user ${user.id}`);

        otpStore.delete(`reset_${phoneWithPlus}`);

        // =============================
        // 5️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "Password reset successfully. You can now login with your new password.",
            phone: phoneWithPlus
        });

    } catch (error) {
        console.error("🔥 ERROR in resetPassword:", error.message);
        return res.status(500).json({
            success: false,
            message: "Server error. Please try again later."
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// OPTIONAL: RESEND OTP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Optional: Resend OTP
 * POST /api/auth/forgot-password/resend-otp
 */
exports.resendOTP = async (req, res) => {
    try {
        console.log("\n📥 [RESEND-OTP] Request received");
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: "Phone number is required"
            });
        }

        const phoneWithPlus = normalizePhoneForDB(phone);

        const user = await User.findOne({ where: { phone: phoneWithPlus } });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "No account found with this phone number"
            });
        }

        // Generate new OTP
        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        // ✅ FIXED: OTP is NOT logged
        console.log(`📲 New OTP generated for user ${user.id} — sending via SMS...`);

        otpStore.set(phoneWithPlus, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0
        });

        const phoneWithoutPlus = normalizePhoneForSMS(phoneWithPlus);
        const smsResult = await sendOTPViaSMS(phoneWithoutPlus, otp);

        if (!smsResult.success) {
            otpStore.delete(phoneWithPlus);
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log(`✅ OTP resent successfully to user ${user.id}`);

        return res.json({
            success: true,
            message: "New OTP sent successfully",
            phone: phoneWithPlus,
            expiresIn: 300
        });

    } catch (error) {
        console.error("🔥 ERROR in resendOTP:", error.message);
        return res.status(500).json({
            success: false,
            message: "Server error. Please try again later."
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = exports;