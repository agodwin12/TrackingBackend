const Voiture = require("../models/Voiture");
const Location = require("../models/Location");

exports.getVehicleDashboardData = async (req, res) => {
    try {
        const vehicleId = Number(req.params.vehicle_id);
        console.log(`📥 Received request for Vehicle ID: ${vehicleId}`);

        if (!vehicleId || vehicleId <= 0) {
            console.log("❌ Invalid vehicle ID.");
            return res.status(400).json({ message: "Invalid vehicle ID" });
        }

        // ✅ Step 1: Fetch the vehicle's mac_id_gps
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["id", "immatriculation", "mac_id_gps"], // Fetch mac_id_gps
        });

        if (!vehicle) {
            console.log("❌ No vehicle found with this ID.");
            return res.status(404).json({ message: "Vehicle not found" });
        }

        console.log(`🔗 Searching for location data using mac_id_gps: ${vehicle.mac_id_gps}`);

        // ✅ Step 2: Fetch the latest location entry using mac_id_gps
        const locationData = await Location.findOne({
            where: { mac_id_gps: vehicle.mac_id_gps },
            order: [["sys_time", "DESC"]], // Get the most recent data
            attributes: ["speed", "status", "mac_id_gps"], // Fetch necessary data
        });

        if (!locationData) {
            console.log("❌ No location data found for this GPS MAC ID.");
            return res.status(404).json({ message: "No location data found" });
        }

        // ✅ Step 3: Interpret GPS status based on the `status` field
        let gpsStatus = "Disconnected"; // Default
        if (locationData.status && /1/.test(locationData.status)) {
            gpsStatus = "Connected"; // If at least one "1" is present
        }

        console.log(`✅ Successfully fetched vehicle dashboard data. GPS Status: ${gpsStatus}`);

        res.json({
            success: true,
            vehicle: {
                id: vehicle.id,
                immatriculation: vehicle.immatriculation,
                gps_mac_id: locationData.mac_id_gps,
                gps_status: gpsStatus,
                speed: locationData.speed || "0",
            },
        });

    } catch (error) {
        console.error("🔥 Error fetching vehicle dashboard data:", error.message);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
