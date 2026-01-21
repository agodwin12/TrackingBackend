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

        // 🔑 STEP 5: Generate Access Token (90 days)
        const accessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id
            },
            process.env.JWT_SECRET,
            { expiresIn: "90d" }
        );

        // 🔄 STEP 6: Generate Refresh Token (180 days)
        const refreshToken = jwt.sign(
            { id: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "180d" }
        );

        // ✅ STEP 7: Calculate expiration date (180 days)
        const refreshTokenExpiresAt = new Date();
        refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 180);

        // ✅ STEP 8: Store refresh token in database
        await user.update({
            refresh_token: refreshToken,
            refresh_token_expires_at: refreshTokenExpiresAt
        });

        console.log(`✅ Refresh token stored for user ${user.id}, expires at ${refreshTokenExpiresAt}`);

        // ✅ STEP 9: Set refresh token in httpOnly cookie (180 days)
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 180 * 24 * 60 * 60 * 1000 // 180 days in milliseconds
        });

        console.log(`✅ Refresh token set in httpOnly cookie`);

        // 🚀 STEP 10: Send Response
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
            refreshToken,
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

// ✅ Logout endpoint
exports.logout = async (req, res) => {
    try {
        const userId = req.user.id;

        await User.update(
            {
                refresh_token: null,
                refresh_token_expires_at: null
            },
            { where: { id: userId } }
        );

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

// ✅ Refresh Token Endpoint
exports.refreshToken = async (req, res) => {
    try {
        let refreshToken = req.cookies.refreshToken;

        if (!refreshToken && req.body.refreshToken) {
            refreshToken = req.body.refreshToken;
            console.log("🔄 Using refresh token from request body");
        } else if (refreshToken) {
            console.log("🔄 Using refresh token from cookie");
        }

        if (!refreshToken) {
            console.log("❌ No refresh token in cookie or body");
            return res.status(401).json({ message: "No refresh token provided" });
        }

        console.log("🔄 Attempting to refresh token...");

        let decoded;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
        } catch (error) {
            console.log("❌ Invalid refresh token:", error.message);
            return res.status(401).json({ message: "Invalid refresh token" });
        }

        const user = await User.findByPk(decoded.id);

        if (!user || user.refresh_token !== refreshToken) {
            console.log("❌ Refresh token not found in database");
            return res.status(401).json({ message: "Invalid refresh token" });
        }

        if (user.refresh_token_expires_at && new Date() > new Date(user.refresh_token_expires_at)) {
            console.log("❌ Refresh token has expired");
            return res.status(401).json({ message: "Refresh token expired" });
        }

        console.log(`✅ Refresh token valid for user ${user.id}`);

        // Generate new access token (90 days)
        const newAccessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id
            },
            process.env.JWT_SECRET,
            { expiresIn: "90d" }
        );

        console.log(`✅ New access token generated for user ${user.id}`);

        res.json({
            message: "Token refreshed successfully",
            accessToken: newAccessToken
        });

    } catch (error) {
        console.error("🔥 Refresh token error:", error);
        res.status(500).json({ message: "Error refreshing token" });
    }
};