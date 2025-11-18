const AssociationUserVoiture = require("../models/AssociationUserVoiture");
const Voiture = require("../models/Voiture");

exports.getUserVehicles = async (req, res) => {
    try {
        const userId = Number(req.params.user_id); // ✅ Ensure userId is an integer
        console.log(`🔍 Fetching vehicles for user ID: ${userId}`);

        if (!userId || userId <= 0) {
            console.log("❌ Invalid user ID.");
            return res.status(400).json({ message: "Invalid user ID" });
        }

        // Step 1: Get voiture_ids from association table
        const associations = await AssociationUserVoiture.findAll({
            where: { user_id: userId },
            attributes: ["voiture_id"],  // Only fetch voiture_id
        });

        if (associations.length === 0) {
            console.log("❌ No vehicles found for this user.");
            return res.status(404).json({ message: "No vehicles found" });
        }

        // Extract voiture IDs
        const voitureIds = associations.map(a => a.voiture_id);
        console.log("🚗 Vehicle IDs found:", voitureIds);

        // Step 2: Get vehicle details from voitures table
        const voitures = await Voiture.findAll({
            where: { id: voitureIds },
            attributes: ["id", "model", "immatriculation", "couleur", "photo"], // ✅ Include "id"
        });

        console.log("✅ Vehicles fetched successfully");
        res.json({ success: true, vehicles: voitures });

    } catch (error) {
        console.error("🔥 Error fetching vehicles:", error.message);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
