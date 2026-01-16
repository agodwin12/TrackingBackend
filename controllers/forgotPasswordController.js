// controllers/forgotPasswordController.js

const bcrypt = require("bcryptjs");
const axios = require("axios");
const User = require("../models/userModel");

// Store OTPs temporarily (in production, use Redis for better scalability)
const otpStore = new Map();

// OTP expiration time (5 minutes)
const OTP_EXPIRY_TIME = 5 * 60 * 1000;

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
        api_token: "1453|kZyPuqcJthu1g01kNhhJ1SdI5O1iYoS9S9ZcwCxL379271c5",
        recipient: phoneWithoutPlus, // ✅ No + prefix for SMS API
        sender_id: "PROXYM",
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
            console.log("📊 Response:", response.data);
            return { success: true, data: response.data };
        } else {
            console.error("❌ SMS API RETURNED ERROR STATUS!");
            console.error("Status:", response.status);
            console.error("Data:", response.data);
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
            console.error("│ Data:", JSON.stringify(error.response.data));
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
        console.log("📝 Request Body:", req.body);

        const { phone } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone) {
            console.error("❌ Phone number is required");
            return res.status(400).json({
                success: false,
                message: "Phone number is required"
            });
        }

        // ✅ FIX: Add + prefix for database lookup
        const phoneWithPlus = normalizePhoneForDB(phone);
        console.log("📱 Original phone:", phone);
        console.log("📱 Phone for DB (with +):", phoneWithPlus);

        // =============================
        // 2️⃣ CHECK IF USER EXISTS
        // =============================
        console.log(`🔎 Checking if user exists with phone: ${phoneWithPlus}`);

        const user = await User.findOne({ where: { phone: phoneWithPlus } });

        if (!user) {
            console.error(`❌ No user found with phone: ${phoneWithPlus}`);
            return res.status(404).json({
                success: false,
                message: "No account found with this phone number"
            });
        }

        console.log(`✅ User found: ${user.nom} ${user.prenom} (ID: ${user.id})`);

        // =============================
        // 3️⃣ GENERATE OTP
        // =============================
        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        console.log(`🔢 Generated OTP: ${otp}`);
        console.log(`⏰ OTP expires at: ${new Date(expiryTime).toLocaleTimeString()}`);

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
        // ✅ FIX: Remove + prefix for SMS API
        const phoneWithoutPlus = normalizePhoneForSMS(phoneWithPlus);
        console.log("📱 Phone for SMS (without +):", phoneWithoutPlus);

        const smsResult = await sendOTPViaSMS(phoneWithoutPlus, otp);

        if (!smsResult.success) {
            console.error("❌ Failed to send SMS");
            console.error("Error details:", smsResult.error);
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log("✅ OTP sent successfully via SMS");

        // =============================
        // 5️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP sent successfully to your phone",
            phone: phoneWithPlus, // Return with + for consistency
            expiresIn: 300 // 5 minutes in seconds
        });

    } catch (error) {
        console.error("🔥 ERROR in requestOTP:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
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
        console.log("📝 Request Body:", req.body);

        const { phone, otp } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone || !otp) {
            console.error("❌ Phone and OTP are required");
            return res.status(400).json({
                success: false,
                message: "Phone and OTP are required"
            });
        }

        // ✅ FIX: Add + prefix to match stored OTP key
        const phoneWithPlus = normalizePhoneForDB(phone);
        console.log("📱 Original phone:", phone);
        console.log("📱 Phone for lookup (with +):", phoneWithPlus);

        // =============================
        // 2️⃣ CHECK IF OTP EXISTS
        // =============================
        const storedOTPData = otpStore.get(phoneWithPlus);

        if (!storedOTPData) {
            console.error("❌ No OTP found for this phone");
            console.log("Available OTP keys:", Array.from(otpStore.keys()));
            return res.status(404).json({
                success: false,
                message: "No OTP request found. Please request a new OTP."
            });
        }

        // =============================
        // 3️⃣ CHECK OTP EXPIRY
        // =============================
        if (Date.now() > storedOTPData.expiryTime) {
            console.error("❌ OTP has expired");
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
            console.error("❌ Too many failed attempts");
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
            console.error("❌ Invalid OTP");
            storedOTPData.attempts += 1;
            otpStore.set(phoneWithPlus, storedOTPData);

            return res.status(400).json({
                success: false,
                message: `Invalid OTP. ${3 - storedOTPData.attempts} attempts remaining.`
            });
        }

        console.log("✅ OTP verified successfully");

        // =============================
        // 6️⃣ GENERATE RESET TOKEN
        // =============================
        // Create a temporary reset token (valid for 10 minutes)
        const resetToken = Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

        const resetTokenExpiry = Date.now() + (10 * 60 * 1000); // 10 minutes

        // Store reset token with phone (with + prefix)
        otpStore.set(`reset_${phoneWithPlus}`, {
            token: resetToken,
            expiryTime: resetTokenExpiry,
            userId: storedOTPData.userId
        });

        // Delete OTP after successful verification
        otpStore.delete(phoneWithPlus);

        console.log("🔑 Reset token generated");

        // =============================
        // 7️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP verified successfully",
            resetToken, // Send this token to client
            phone: phoneWithPlus, // Return with + for consistency
            userId: storedOTPData.userId
        });

    } catch (error) {
        console.error("🔥 ERROR in verifyOTP:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
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
        console.log("📝 Request Body:", req.body);

        const { phone, resetToken, newPassword } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        if (!phone || !resetToken || !newPassword) {
            console.error("❌ Missing required fields");
            return res.status(400).json({
                success: false,
                message: "Phone, reset token, and new password are required"
            });
        }

        if (newPassword.length < 6) {
            console.error("❌ Password too short");
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        // ✅ FIX: Add + prefix to match stored reset token key
        const phoneWithPlus = normalizePhoneForDB(phone);
        console.log("📱 Original phone:", phone);
        console.log("📱 Phone for lookup (with +):", phoneWithPlus);

        // =============================
        // 2️⃣ VERIFY RESET TOKEN
        // =============================
        const resetData = otpStore.get(`reset_${phoneWithPlus}`);

        if (!resetData) {
            console.error("❌ No reset token found");
            console.log("Available reset keys:", Array.from(otpStore.keys()).filter(k => k.startsWith('reset_')));
            return res.status(404).json({
                success: false,
                message: "Invalid or expired reset session. Please start over."
            });
        }

        if (resetData.token !== resetToken) {
            console.error("❌ Invalid reset token");
            return res.status(400).json({
                success: false,
                message: "Invalid reset token"
            });
        }

        if (Date.now() > resetData.expiryTime) {
            console.error("❌ Reset token expired");
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
            console.error("❌ User not found");
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        console.log(`✅ User found: ${user.nom} ${user.prenom}`);

        // =============================
        // 4️⃣ HASH NEW PASSWORD
        // =============================
        console.log("🔒 Hashing new password...");
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // =============================
        // 5️⃣ UPDATE PASSWORD
        // =============================
        await user.update({
            password: hashedPassword,
            is_first_login: false
        });

        console.log("✅ Password updated successfully");

        // Delete reset token
        otpStore.delete(`reset_${phoneWithPlus}`);

        // =============================
        // 6️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "Password reset successfully. You can now login with your new password.",
            phone: phoneWithPlus
        });

    } catch (error) {
        console.error("🔥 ERROR in resetPassword:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
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

        // ✅ FIX: Add + prefix for database lookup
        const phoneWithPlus = normalizePhoneForDB(phone);
        console.log("📱 Original phone:", phone);
        console.log("📱 Phone for DB (with +):", phoneWithPlus);

        // Check if user exists
        const user = await User.findOne({ where: { phone: phoneWithPlus } });

        if (!user) {
            console.error(`❌ No user found with phone: ${phoneWithPlus}`);
            return res.status(404).json({
                success: false,
                message: "No account found with this phone number"
            });
        }

        console.log(`✅ User found: ${user.nom} ${user.prenom}`);

        // Generate new OTP
        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        console.log(`🔢 New OTP: ${otp}`);

        // Store OTP with phone (with + prefix)
        otpStore.set(phoneWithPlus, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0
        });

        // ✅ FIX: Remove + prefix for SMS API
        const phoneWithoutPlus = normalizePhoneForSMS(phoneWithPlus);
        console.log("📱 Phone for SMS (without +):", phoneWithoutPlus);

        // Send SMS
        const smsResult = await sendOTPViaSMS(phoneWithoutPlus, otp);

        if (!smsResult.success) {
            console.error("❌ Failed to send SMS");
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log("✅ OTP resent successfully");

        return res.json({
            success: true,
            message: "New OTP sent successfully",
            phone: phoneWithPlus, // Return with + for consistency
            expiresIn: 300
        });

    } catch (error) {
        console.error("🔥 ERROR in resendOTP:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = exports;