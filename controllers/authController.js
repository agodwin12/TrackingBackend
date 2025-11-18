const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
    const { phone, password, keepMeLoggedIn } = req.body;

    console.log("🔹 Incoming Login Request");
    console.log(`📞 Phone: ${phone}`);
    console.log(`🔐 Password Provided: ${password ? "Yes" : "No"}`);
    console.log(`🔁 Keep Me Logged In: ${keepMeLoggedIn}`);

    try {
        // Check if user exists
        console.log("🔍 Searching for user in database...");
        const user = await User.findOne({ where: { phone } });

        if (!user) {
            console.log("❌ User not found!");
            return res.status(401).json({ message: "User not found" });
        }

        console.log("✅ User found:", {
            id: user.id,
            user_unique_id: user.user_unique_id,
            nom: user.nom,
            prenom: user.prenom,
            phone: user.phone,
            email: user.email,
        });

        // Validate password
        console.log("🔑 Validating password...");
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            console.log("❌ Invalid password!");
            return res.status(401).json({ message: "Invalid credentials" });
        }
        console.log("✅ Password is correct");

        // Generate access token
        console.log("🔑 Generating access token...");
        const accessToken = jwt.sign(
            { id: user.id, phone: user.phone, user_unique_id: user.user_unique_id },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        console.log("✅ Access Token Created");

        // Generate refresh token if "Keep Me Logged In" is checked
        let refreshToken = null;
        if (keepMeLoggedIn) {
            console.log("🔄 Generating refresh token...");
            refreshToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
            console.log("✅ Refresh Token Created");
        }

        // Return response
        console.log("🚀 Login successful! Sending response...");
        res.json({
            message: "Login successful",
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

        console.log("✅ Response sent successfully");
    } catch (error) {
        console.error("🔥 Server Error:", error.message);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
