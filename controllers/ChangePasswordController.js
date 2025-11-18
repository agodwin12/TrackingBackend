const bcrypt = require("bcryptjs"); // ✅ For hashing passwords
const User = require("../models/userModel");
const AssociationUserVoiture = require("../models/AssociationUserVoiture");

/**
 * Change user password based on the vehicle ID.
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
