// controllers/forgotPasswordController.js

const bcrypt = require("bcryptjs");
const axios = require("axios");
const User = require("../models/userModel");

// Store OTPs temporarily (in production, use Redis for better scalability)
const otpStore = new Map();

// OTP expiration time (5 minutes)
const OTP_EXPIRY_TIME = 5 * 60 * 1000;

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Send OTP via Techsoft SMS API
 * API Documentation: https://app.techsoftsms.com/api/http/sms/send
 */
async function sendOTPViaSMS(phone, otp) {

    const apiUrl = "https://app.techsoft-sms.com/api/http/sms/send/";
    const payload = {
        api_token: "1453|kZyPuqcJthu1g01kNhhJ1SdI5O1iYoS9S9ZcwCxL379271c5",
        recipient: phone,
        sender_id: "PROXYM-GROUP",
        type: "plain",
        message: `Your PROXYM TRACKING password reset OTP is: ${otp}. Valid for 5 minutes.`
    };


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



        if (response.status >= 200 && response.status < 300) {
            console.log("✅ SMS API CALL SUCCESSFUL!");
            return { success: true, data: response.data };
        } else {
            console.error("❌ SMS API RETURNED ERROR STATUS!");
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

        // =============================
        // 2️⃣ CHECK IF USER EXISTS
        // =============================
        console.log(`🔎 Checking if user exists with phone: ${phone}`);

        const user = await User.findOne({ where: { phone } });

        if (!user) {
            console.error(`❌ No user found with phone: ${phone}`);
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

        // Store OTP with expiry time
        otpStore.set(phone, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0
        });

        // =============================
        // 4️⃣ SEND OTP VIA SMS
        // =============================
        const smsResult = await sendOTPViaSMS(phone, otp);

        if (!smsResult.success) {
            console.error("❌ Failed to send SMS");
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log("✅ OTP sent successfully");

        // =============================
        // 5️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP sent successfully to your phone",
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

        // =============================
        // 2️⃣ CHECK IF OTP EXISTS
        // =============================
        const storedOTPData = otpStore.get(phone);

        if (!storedOTPData) {
            console.error("❌ No OTP found for this phone");
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
            otpStore.delete(phone);
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
            otpStore.delete(phone);
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
            otpStore.set(phone, storedOTPData);

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

        // Store reset token
        otpStore.set(`reset_${phone}`, {
            token: resetToken,
            expiryTime: resetTokenExpiry,
            userId: storedOTPData.userId
        });

        // Delete OTP after successful verification
        otpStore.delete(phone);

        console.log("🔑 Reset token generated");

        // =============================
        // 7️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "OTP verified successfully",
            resetToken, // Send this token to client
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

        // =============================
        // 2️⃣ VERIFY RESET TOKEN
        // =============================
        const resetData = otpStore.get(`reset_${phone}`);

        if (!resetData) {
            console.error("❌ No reset token found");
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
            otpStore.delete(`reset_${phone}`);
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
        otpStore.delete(`reset_${phone}`);

        // =============================
        // 6️⃣ SUCCESS RESPONSE
        // =============================
        return res.json({
            success: true,
            message: "Password reset successfully. You can now login with your new password."
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

        // Check if user exists
        const user = await User.findOne({ where: { phone } });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "No account found with this phone number"
            });
        }

        // Generate new OTP
        const otp = generateOTP();
        const expiryTime = Date.now() + OTP_EXPIRY_TIME;

        console.log(`🔢 New OTP: ${otp}`);

        // Store OTP
        otpStore.set(phone, {
            otp,
            expiryTime,
            userId: user.id,
            attempts: 0
        });

        // Send SMS
        const smsResult = await sendOTPViaSMS(phone, otp);

        if (!smsResult.success) {
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP. Please try again."
            });
        }

        console.log("✅ OTP resent successfully");

        return res.json({
            success: true,
            message: "New OTP sent successfully",
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