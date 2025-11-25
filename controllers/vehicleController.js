// controllers/vehicleController.js

const AssociationUserVoiture = require("../models/AssociationUserVoiture");
const Voiture = require("../models/voiture");
const Location = require("../models/location");

/**
 * Get vehicle details for a user
 * GET /vehicles/user/:userId
 */
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

/**
 * Get engine status from latest location record
 * Parses binary status string at bit position 2
 *
 * GET /vehicles/:vehicleId/engine-status
 */
exports.getEngineStatus = async (req, res) => {
    console.log("\n🔍 ========== GET ENGINE STATUS ==========");

    try {
        const { vehicleId } = req.params;
        console.log(`📥 Vehicle ID: ${vehicleId}`);

        // Validate vehicleId
        if (!vehicleId || isNaN(vehicleId)) {
            return res.status(400).json({
                success: false,
                message: "Valid vehicleId is required"
            });
        }

        // Get vehicle's GPS MAC ID
        console.log(`🔍 Looking up vehicle...`);
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["id", "mac_id_gps", "immatriculation"],
        });

        if (!vehicle || !vehicle.mac_id_gps) {
            console.error("❌ Vehicle or MAC ID not found");
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const macIdGps = vehicle.mac_id_gps;
        console.log(`✅ Found vehicle: ${vehicle.immatriculation} (MAC: ${macIdGps})`);

        // Get latest location record for this vehicle
        console.log(`📡 Fetching latest location from database...`);
        const latestLocation = await Location.findOne({
            where: { mac_id_gps: macIdGps },
            order: [["sys_time", "DESC"]], // Most recent first
            attributes: ["id", "status", "sys_time", "latitude", "longitude", "speed"],
            raw: true
        });

        if (!latestLocation) {
            console.error("❌ No location data found");
            return res.status(404).json({
                success: false,
                message: "No location data available for this vehicle"
            });
        }

        console.log(`✅ Latest location found: ID ${latestLocation.id}`);
        console.log(`   📅 Timestamp: ${latestLocation.sys_time}`);
        console.log(`   📊 Raw Status: ${latestLocation.status}`);

        // Parse engine status from binary string
        const engineOn = parseEngineStatus(latestLocation.status);
        console.log(`   🔧 Engine Status: ${engineOn ? "ON (UNLOCKED)" : "OFF (LOCKED)"}`);

        // Calculate data age
        const dataAge = Math.floor((Date.now() - new Date(latestLocation.sys_time).getTime()) / 1000);
        console.log(`   ⏰ Data Age: ${dataAge} seconds`);

        console.log("========== REQUEST COMPLETED ==========\n");

        return res.json({
            success: true,
            vehicleId: parseInt(vehicleId),
            macIdGps: macIdGps,
            engineOn: engineOn,
            lastUpdate: latestLocation.sys_time,
            dataAgeSeconds: dataAge,
            latitude: latestLocation.latitude,
            longitude: latestLocation.longitude,
            speed: latestLocation.speed,
            rawStatus: latestLocation.status
        });

    } catch (error) {
        console.error("\n🔥 ========== ERROR ==========");
        console.error("🔥 Error in getEngineStatus:", error.message);
        console.error("🔥 Stack:", error.stack);
        console.log("========== ERROR END ==========\n");

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

/**
 * Parse engine status from binary status string
 * Bit position 2 (from right, 0-indexed) represents engine/relay status
 *
 * Example: "001001100"
 * Position: 876543210
 *                  ^
 *                  └── Bit 2 = Engine (1 = ON, 0 = OFF)
 *
 * @param {string} statusString - Binary status string from GPS device
 * @returns {boolean} - true if engine ON, false if engine OFF
 */
function parseEngineStatus(statusString) {
    if (!statusString || typeof statusString !== 'string') {
        console.warn("⚠️ Invalid status string, defaulting to engine OFF");
        return false;
    }

    // Remove any whitespace
    const cleanStatus = statusString.trim();

    // Reverse the string to make indexing easier (bit 0 = rightmost)
    const reversedStatus = cleanStatus.split('').reverse().join('');

    // Get bit at position 2 (3rd bit from right)
    const engineBit = reversedStatus[2];

    console.log(`   🔍 Parsing: "${cleanStatus}" → Reversed: "${reversedStatus}" → Bit[2]: "${engineBit}"`);

    // Return true if bit is '1', false otherwise
    return engineBit === '1';
}

// Export the helper function for testing
exports.parseEngineStatus = parseEngineStatus;


// Add after the existing getEngineStatus method

/**
 * Force fetch latest GPS data for a vehicle
 * Useful after sending commands to get immediate status update
 */
exports.forceGPSUpdate = async (req, res) => {
    console.log("\n🔄 ========== FORCE GPS UPDATE ==========");

    try {
        const { vehicleId } = req.params;
        console.log(`📥 Vehicle ID: ${vehicleId}`);

        // Verify vehicle exists
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["id", "mac_id_gps", "immatriculation"],
        });

        if (!vehicle || !vehicle.mac_id_gps) {
            console.error("❌ Vehicle or MAC ID not found");
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const macIdGps = vehicle.mac_id_gps;
        console.log(`✅ Found vehicle: ${vehicle.immatriculation} (MAC: ${macIdGps})`);

        // Import the GPS service
        const gpsService = require('../location');

        console.log('🔄 Triggering immediate GPS data fetch...');

        // Call the existing fetchGPSData function (it fetches all devices and saves to DB)
        await gpsService.fetchGPSData();

        console.log("✅ GPS data fetch completed");
        console.log("========== FORCE GPS UPDATE COMPLETE ==========\n");

        return res.json({
            success: true,
            message: "GPS data fetch triggered and completed",
            vehicleId: vehicleId,
            macIdGps: macIdGps
        });

    } catch (error) {
        console.error("\n🔥 ========== ERROR ==========");
        console.error("🔥 Error forcing GPS update:", error.message);
        console.error("🔥 Stack:", error.stack);
        console.log("========== ERROR END ==========\n");

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};