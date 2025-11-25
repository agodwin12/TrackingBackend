// controllers/changePasswordController.js (add this new function)

const bcrypt = require("bcryptjs");
const User = require("../models/userModel");
const AssociationUserVoiture = require("../models/AssociationUserVoiture");

/**
 * Change user password based on the vehicle ID (existing function - keep as is)
 */
exports.changePasswordByVehicleId = async (req, res) => {
    try {
        console.log("📥 Received password change request.");
        console.log("🔹 Request Body:", req.body);

        const { vehicleId, old_password, new_password } = req.body;

        if (!vehicleId || !old_password || !new_password) {
            console.error("❌ Missing required fields.");
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        console.log(`🔎 Searching for the user linked to Vehicle ID: ${vehicleId}`);

        // ✅ Step 1: Find the user linked to the vehicle
        const association = await AssociationUserVoiture.findOne({
            where: { voiture_id: vehicleId },
            attributes: ["user_id"],
        });

        if (!association) {
            console.error("❌ No user found for this vehicle.");
            return res.status(404).json({ success: false, message: "No user associated with this vehicle." });
        }

        const userId = association.user_id;
        console.log(`✅ Found associated user! User ID: ${userId}`);

        // ✅ Step 2: Fetch user details
        console.log(`🔎 Fetching details for User ID: ${userId}`);
        const user = await User.findOne({ where: { id: userId } });

        if (!user) {
            console.error("❌ User not found.");
            return res.status(404).json({ success: false, message: "User not found" });
        }

        console.log(`✅ User found: ${user.nom} ${user.prenom} (ID: ${user.id})`);

        // ✅ Step 3: Verify old password
        console.log("🔑 Verifying old password...");
        const isMatch = await bcrypt.compare(old_password, user.password);

        if (!isMatch) {
            console.error("❌ Incorrect old password.");
            return res.status(400).json({ success: false, message: "Incorrect old password" });
        }

        console.log("✅ Old password verified successfully.");

        // ✅ Step 4: Hash new password
        console.log("🔒 Hashing new password...");
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // ✅ Step 5: Update password in the database
        console.log("💾 Updating user password in database...");
        await user.update({ password: hashedPassword });

        console.log("✅ Password updated successfully for User ID:", userId);
        return res.json({ success: true, message: "Password changed successfully" });

    } catch (error) {
        console.error("🔥 Server error changing password:", error.message);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};



/**
 * 🆕 Set password for first-time login users (no old password required)
 */
exports.setPasswordFirstLogin = async (req, res) => {
    try {
        console.log("📥 [PASSWORD-FIRST-LOGIN] Request received.");
        console.log("📝 Request Body:", req.body);

        const { userId, newPassword } = req.body;

        // =============================
        // 1️⃣ VALIDATION
        // =============================
        console.log("🔍 Validating required fields...");
        if (!userId || !newPassword) {
            console.error("❌ Validation failed: Missing required fields.");
            return res.status(400).json({
                success: false,
                message: "Missing required fields"
            });
        }

        console.log("🔍 Checking password length...");
        if (newPassword.length < 6) {
            console.error("❌ Validation failed: Password too short.");
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        console.log(`🔎 Searching for user with ID: ${userId}`);

        // =============================
        // 2️⃣ FETCH USER
        // =============================
        const user = await User.findOne({ where: { id: userId } });

        if (!user) {
            console.error(`❌ No user found with ID: ${userId}`);
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        console.log(`✅ User found: ${user.nom} ${user.prenom} (ID: ${user.id})`);
        console.log(`📌 Current is_first_login: ${user.is_first_login}`);

        // =============================
        // 3️⃣ HASH PASSWORD
        // =============================
        console.log("🔒 Hashing new password...");
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        console.log("🔒 Password hashed successfully.");

        // =============================
        // 4️⃣ UPDATE DATABASE
        // =============================
        console.log("💾 Updating user record in database...");

        await user.update({
            password: hashedPassword,
            is_first_login: false
        });

        console.log("✅ Database update successful!");
        console.log(`🔁 Updated is_first_login => false for user ID: ${userId}`);
        console.log(`🔁 Updated password (hashed): ${hashedPassword}`);

        // =============================
        // 5️⃣ SUCCESS RESPONSE
        // =============================
        console.log("🚀 Returning success response to client...");

        return res.json({
            success: true,
            message: "Password set successfully"
        });

    } catch (error) {
        // =============================
        // 6️⃣ ERROR HANDLING
        // =============================
        console.error("🔥 ERROR in setPasswordFirstLogin:", error);
        console.error("📛 Error Message:", error.message);

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};


exports.setPassword = async (req, res) => {
    try {
        const { userId, newPassword } = req.body;

        console.log("\n📌 [setPassword] Request received");
        console.log("➡ User ID:", userId);

        // Validation
        if (!userId || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "User ID and new password are required"
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        // Find user
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        console.log("✅ User found:", user.email);
        console.log("📌 Current is_first_login:", user.is_first_login);

        // Hash the new password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // Update user's password AND mark as not first login
        user.password = hashedPassword;
        user.is_first_login = false; // ✅ CRITICAL: Mark as not first login anymore

        await user.save();

        console.log("✅ Password updated successfully");
        console.log("✅ is_first_login set to false");

        res.json({
            success: true,
            message: "Password set successfully",
            data: {
                userId: user.id,
                email: user.email
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in setPassword:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};