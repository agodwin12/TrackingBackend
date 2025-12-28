const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");


const normalizePhone = (phone) => {
    if (!phone) return null;

    // Remove all spaces, dashes, parentheses
    let cleaned = phone.replace(/[\s\-()]/g, '');

    // Add '+' if not present
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

            // 🛡️ SECURITY: Generic error message (don't reveal if user exists)
            return res.status(401).json({
                message: "Invalid phone number or password"
            });
        }

        // ✅ STEP 5: Check if Account is Locked (Future Enhancement)
        // TODO: Implement account lockout logic here

        if (process.env.NODE_ENV !== "production") {
            console.log("✅ User authenticated:", {
                id: user.id,
                user_unique_id: user.user_unique_id,
                phone: user.phone,
            });
        }

        // 🔑 STEP 6: Generate Access Token
        const accessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id
            },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        // 🔄 STEP 7: Generate Refresh Token (if requested)
        let refreshToken = null;
        if (keepMeLoggedIn) {
            refreshToken = jwt.sign(
                { id: user.id },
                process.env.JWT_SECRET,
                { expiresIn: "7d" }
            );
        }

        // 🚀 STEP 8: Send Response
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