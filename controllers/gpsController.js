// controllers/gpsController.js
const { sendGpsCommandWithFallback, getRealtimeStatusByMacWithFallback } = require("../services/GpsService");
const Voiture = require("../models/voiture");
const SimGps = require("../models/sim_gps");
const Command = require("../models/Command"); // ✅ ADD THIS

exports.issueCommandToVehicle = async (req, res) => {
    console.log("📥 Received request to issue GPS command:", req.body);

    try {
        let { vehicleId, command, params = "", sendTime = "" } = req.body;

        if (!vehicleId) {
            return res.status(400).json({ success: false, message: "vehicleId is required" });
        }

        command = String(command || "").trim().toUpperCase();
        const ALLOWED = new Set(["OPENRELAY", "CLOSERELAY"]);
        if (!ALLOWED.has(command)) {
            return res.status(400).json({
                success: false,
                message: "Invalid command. Use 'OPENRELAY' or 'CLOSERELAY'.",
            });
        }

        // ✅ Map command to type_commande
        const typeCommande = command === "OPENRELAY" ? "ALLUMAGE" : "COUPURE";

        // 1) Get vehicle MAC
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["mac_id_gps", "model"],
        });

        if (!vehicle || !vehicle.mac_id_gps) {
            return res.status(404).json({ success: false, message: "Vehicle or MAC not found" });
        }

        const macIdGps = String(vehicle.mac_id_gps).trim();

        // 2) Find account name from sim_gps
        const simGpsRecord = await SimGps.findOne({
            where: { mac_id: macIdGps },
            attributes: ["account_name"],
            order: [["updated_at", "DESC"]],
        });

        if (!simGpsRecord?.account_name) {
            return res.status(404).json({
                success: false,
                message: `No account found in sim_gps for MAC ${macIdGps}`,
            });
        }

        const accountName = String(simGpsRecord.account_name).trim().toLowerCase();
        console.log(`📡 Device ${macIdGps} belongs to account: ${accountName}`);

        // ✅ Get user_id from request (assuming auth middleware sets req.user)
        const userId = req.user?.id || null;

        // ✅ Generate unique command number
        const cmdNo = `CMD-${Date.now()}-${vehicleId}`;

        // 3) Send command with fallback (password is now automatic based on account)
        const result = await sendGpsCommandWithFallback({
            accountName,
            macId: macIdGps,
            command,
            params,
            sendTime,
        });

        // ✅ Determine status based on result
        const commandStatus = result.ok ? 'success' : 'failed';

        // ✅ Save command to database
        try {
            await Command.create({
                user_id: userId,
                employe_id: null,
                vehicule_id: vehicleId,
                CmdNo: cmdNo,
                status: commandStatus,
                type_commande: typeCommande,
            });

            console.log(`✅ Command saved to database: ${cmdNo} (${typeCommande})`);
        } catch (dbError) {
            console.error(`⚠️ Failed to save command to database:`, dbError);
            // Don't fail the request if DB save fails
        }

        if (!result.ok) {
            return res.status(502).json({
                success: false,
                message: result.message || "Command failed",
                vehicleId,
                macIdGps,
                accountName,
                commandNumber: cmdNo,
                retried: result.retried,
                response: result.providerResp,
            });
        }

        return res.json({
            success: true,
            message: `${command} sent successfully`,
            vehicleId,
            macIdGps,
            accountName,
            commandNumber: cmdNo,
            typeCommande: typeCommande,
            retried: result.retried,
            response: result.providerResp,
        });
    } catch (error) {
        console.error("🔥 Command error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message,
        });
    }
};

exports.getRealtimeVehicleStatus = async (req, res) => {
    console.log("\n📥 ========== GET REALTIME STATUS ==========");

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

        // Get vehicle's GPS MAC ID from database
        console.log(`🔍 Looking up vehicle MAC ID...`);
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["mac_id_gps", "model"],
        });

        if (!vehicle || !vehicle.mac_id_gps) {
            console.error("❌ Vehicle or MAC ID not found");
            return res.status(404).json({
                success: false,
                message: "Vehicle or MAC ID not found"
            });
        }

        const macIdGps = String(vehicle.mac_id_gps).trim();
        const carModel = vehicle.model;
        console.log(`✅ Found vehicle: ${carModel} (MAC: ${macIdGps})`);

        // Get account name from sim_gps
        const simGpsRecord = await SimGps.findOne({
            where: { mac_id: macIdGps },
            attributes: ["account_name"],
            order: [["updated_at", "DESC"]],
        });

        if (!simGpsRecord?.account_name) {
            console.error("❌ No account found in sim_gps");
            return res.status(404).json({
                success: false,
                message: `No account found in sim_gps for MAC ${macIdGps}`,
            });
        }

        const accountName = String(simGpsRecord.account_name).trim().toLowerCase();
        console.log(`📡 Device ${macIdGps} belongs to account: ${accountName}`);

        // Get status using GPS service with fallback
        console.log(`🔍 Fetching vehicle status...`);
        const result = await getRealtimeStatusByMacWithFallback({
            accountName,
            macId: macIdGps
        });

        if (!result.success) {
            console.error(`❌ Failed to get status: ${result.message}`);
            return res.status(502).json({
                success: false,
                message: "Failed to retrieve vehicle status",
                error: result.message
            });
        }

        const statusData = result.status;

        console.log(`✅ Status retrieved successfully!`);
        console.log(`   🔧 Engine: ${statusData.oilState ? 'ON' : 'OFF'}`);
        console.log(`   🔌 ACC: ${statusData.accState ? 'ON' : 'OFF'}`);
        console.log(`   📡 GPS Signal: ${statusData.gps_status}`);
        console.log(`   🏎️ Speed: ${statusData.speed} km/h`);

        console.log("========== REQUEST COMPLETED ==========\n");

        // Return standardized response
        return res.json({
            success: true,
            vehicleId: parseInt(vehicleId),
            macIdGps: macIdGps,
            carModel: carModel,
            accountName: accountName,
            engineOn: statusData.oilState || false,
            accOn: statusData.accState || false,
            gpsStatus: statusData.gps_status,
            speed: statusData.speed || 0,
            rawStatus: statusData.status,
            retried: result.retried,
        });

    } catch (error) {
        console.error("\n🔥 ========== ERROR ==========");
        console.error("🔥 Error in getRealtimeVehicleStatus:", error.message);
        console.error("🔥 Stack:", error.stack);
        console.log("========== ERROR END ==========\n");

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};