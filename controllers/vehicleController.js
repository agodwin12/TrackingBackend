const AssociationUserVoiture = require("../models/AssociationUserVoiture");
const Voiture = require("../models/Voiture");
const Location = require("../models/Location");

exports.getVehicleDetails = async (req, res) => {
    try {
        const userId = Number(req.params.userId); // ✅ Fix: Ensure userId is an integer
        console.log("📥 Received request for user ID:", userId);

        if (!userId || userId <= 0) {
            console.log("❌ Invalid user ID received.");
            return res.status(400).json({ message: "Invalid user ID" });
        }

        // Find the vehicle associated with the user
        const association = await AssociationUserVoiture.findOne({
            where: { user_id: userId }
        });

        if (!association) {
            console.log("❌ No vehicle found for this user.");
            return res.status(404).json({ message: "No vehicle found for this user" });
        }

        console.log("✅ Association record found:", association.toJSON());

        // Fetch vehicle details
        const vehicle = await Voiture.findOne({
            where: { id: association.voiture_id }
        });

        if (!vehicle) {
            console.log("❌ Vehicle not found.");
            return res.status(404).json({ message: "Vehicle not found" });
        }

        console.log("🚗 Vehicle details:", vehicle.toJSON());

        // Fetch latest GPS data for this vehicle
        const location = await Location.findOne({
            where: { mac_id_gps: vehicle.mac_id_gps },
            order: [['created_at', 'DESC']]
        });

        let gpsStatus = "Disconnected"; // Default status
        let speed = null;

        if (location) {
            console.log("📡 Latest GPS location data:", location.toJSON());

            if (location.status) {
                console.log("🔍 GPS status raw data:", location.status);
                const statusDigits = location.status.replace(/\D/g, ""); // Remove non-numeric characters
                console.log("🔢 Extracted numeric status:", statusDigits);

                if (statusDigits.includes("1")) {
                    gpsStatus = "Connected";
                }
            }

            speed = location.speed || 0;
        } else {
            console.log("⚠️ No GPS data found for this vehicle.");
        }

        // Prepare response
        const response = {
            gps_mac_id: vehicle.mac_id_gps,
            gps_status: gpsStatus,
            speed: speed,
            car_model: vehicle.model
        };

        console.log("✅ Final response:", response);
        return res.status(200).json(response);

    } catch (error) {
        console.error("🔥 Error fetching vehicle details:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};
