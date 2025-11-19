const User = require("../models/userModel");
const Voiture = require("../models/voiture");
const AssociationUserVoiture = require("../models/AssociationUserVoiture"); // ✅ Model linking users to vehicles

/**
 * Fetch user information by vehicle ID
 */
exports.getUserByVehicleId = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        console.log(`📥 Received request to get user details for Vehicle ID: ${vehicleId}`);

        // ✅ Step 1: Find user linked to the vehicle
        const association = await AssociationUserVoiture.findOne({
            where: { voiture_id: vehicleId },
            attributes: ["user_id"],
        });

        if (!association) {
            console.error("❌ No user found for this vehicle.");
            return res.status(404).json({ success: false, message: "No user associated with this vehicle." });
        }

        const userId = association.user_id;
        console.log(`🔗 Vehicle is linked to User ID: ${userId}`);

        // ✅ Step 2: Fetch user details
        const user = await User.findOne({
            where: { id: userId },
            attributes: ["id", "user_unique_id", "nom", "prenom", "phone", "email", "ville", "quartier", "photo"],
        });

        if (!user) {
            console.error("❌ User not found.");
            return res.status(404).json({ success: false, message: "User not found" });
        }

        console.log("✅ User details fetched successfully.");
        res.json({ success: true, user });

    } catch (error) {
        console.error("🔥 Error fetching user profile:", error.message);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
};
