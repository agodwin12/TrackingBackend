// controllers/authController.js
const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");

const normalizePhone = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
    }
    return cleaned;
};

exports.login = async (req, res) => {
    try {
        // ✅ STEP 1: Validate Input
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log("❌ Validation failed:", errors.array());
            return res.status(400).json({
                message: "Invalid input",
                errors: errors.array()
            });
        }

        const { phone, password, keepMeLoggedIn } = req.body;

        // 🔧 STEP 2: Normalize Phone Number
        const normalizedPhone = normalizePhone(phone);

        if (process.env.NODE_ENV !== "production") {
            console.log("🔹 Login Attempt");
            console.log(`📞 Original Phone: ${phone}`);
            console.log(`📞 Normalized Phone: ${normalizedPhone}`);
            console.log(`🔁 Keep Me Logged In: ${keepMeLoggedIn}`);
        }

        // 🔍 STEP 3: Find User
        const user = await User.findOne({ where: { phone: normalizedPhone } });

        // 🔐 STEP 4: Validate Password
        if (!user || !(await bcrypt.compare(password, user.password))) {
            console.log(`❌ Failed login attempt for: ${normalizedPhone}`);
            return res.status(401).json({
                message: "Invalid phone number or password"
            });
        }

        if (process.env.NODE_ENV !== "production") {
            console.log("✅ User authenticated:", {
                id: user.id,
                user_unique_id: user.user_unique_id,
                phone: user.phone,
            });
        }

        // 🔑 STEP 5: Generate Access Token (1 hour)
        const accessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id
            },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        // 🔄 STEP 6: ALWAYS Generate Refresh Token (30 days)
        const refreshToken = jwt.sign(
            { id: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "30d" }
        );

        // ✅ STEP 7: Calculate expiration date
        const refreshTokenExpiresAt = new Date();
        refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 30); // 30 days from now

        // ✅ STEP 8: Store refresh token in database
        await user.update({
            refresh_token: refreshToken,
            refresh_token_expires_at: refreshTokenExpiresAt
        });

        console.log(`✅ Refresh token stored for user ${user.id}, expires at ${refreshTokenExpiresAt}`);

        // ✅ STEP 9: Set refresh token in httpOnly cookie (secure, can't be accessed by JS)
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,      // Cannot be accessed by JavaScript
            secure: process.env.NODE_ENV === 'production', // HTTPS only in production
            sameSite: 'strict',  // CSRF protection
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days in milliseconds
        });

        console.log(`✅ Refresh token set in httpOnly cookie`);

        // 🚀 STEP 10: Send Response (Frontend only sees access token)
        res.json({
            message: "Login successful",
            isFirstLogin: user.is_first_login,
            user: {
                id: user.id,
                user_unique_id: user.user_unique_id,
                nom: user.nom,
                prenom: user.prenom,
                phone: user.phone,
                email: user.email,
                ville: user.ville,
                quartier: user.quartier,
                photo: user.photo,
            },
            accessToken,
            // ✅ No need to send refreshToken to frontend - it's in cookie!
        });

        if (process.env.NODE_ENV !== "production") {
            console.log("✅ Login successful for:", normalizedPhone);
        }

    } catch (error) {
        console.error("🔥 Login Error:", error.message);
        res.status(500).json({
            message: "Server error. Please try again later."
        });
    }
};

// ✅ NEW: Logout endpoint to clear refresh token
exports.logout = async (req, res) => {
    try {
        const userId = req.user.id;

        // Clear refresh token from database
        await User.update(
            {
                refresh_token: null,
                refresh_token_expires_at: null
            },
            { where: { id: userId } }
        );

        // Clear refresh token cookie
        res.clearCookie('refreshToken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        });

        console.log(`✅ User ${userId} logged out, refresh token cleared`);

        res.json({ message: "Logged out successfully" });

    } catch (error) {
        console.error("🔥 Logout error:", error);
        res.status(500).json({ message: "Error logging out" });
    }
};