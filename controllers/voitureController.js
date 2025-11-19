const AssociationUserVoiture = require("../models/AssociationUserVoiture");
const Voiture = require("../models/voiture");

exports.getUserVehicles = async (req, res) => {
    try {
        const userId = Number(req.params.user_id);
        console.log(`🔍 Fetching vehicles for user ID: ${userId}`);

        if (!userId || userId <= 0) {
            console.log("❌ Invalid user ID.");
            return res.status(400).json({ message: "Invalid user ID" });
        }

        // Step 1: Get voiture_ids from association table
        const associations = await AssociationUserVoiture.findAll({
            where: { user_id: userId },
            attributes: ["voiture_id"],
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
            attributes: [
                "id",
                "marque",        // 🆕 ADDED - Brand name
                "model",
                "immatriculation",
                "couleur",
                "photo",
                "nickname"       // 🆕 ADDED - Nickname
            ],
        });

        console.log("✅ Vehicles fetched successfully");
        res.json({ success: true, vehicles: voitures });

    } catch (error) {
        console.error("🔥 Error fetching vehicles:", error.message);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};




exports.updateVehicleNickname = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { nickname } = req.body;

        console.log("📝 Update Nickname Request");
        console.log("Vehicle ID:", vehicleId);
        console.log("New Nickname:", nickname);

        // Validate nickname (optional but recommended)
        if (nickname && nickname.length > 50) {
            return res.status(400).json({
                success: false,
                message: "Nickname must be 50 characters or less"
            });
        }

        // Find vehicle
        const vehicle = await Voiture.findByPk(vehicleId);

        if (!vehicle) {
            console.log("❌ Vehicle not found");
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        console.log("✅ Vehicle found:", vehicle.immatriculation);

        // Update nickname
        await vehicle.update({ nickname: nickname || null });

        console.log("✅ Nickname updated successfully");

        res.json({
            success: true,
            message: "Nickname updated successfully",
            vehicle: {
                id: vehicle.id,
                immatriculation: vehicle.immatriculation,
                marque: vehicle.marque,
                model: vehicle.model,
                nickname: vehicle.nickname
            }
        });

    } catch (error) {
        console.error("🔥 Error updating nickname:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};