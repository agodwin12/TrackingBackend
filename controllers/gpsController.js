// controllers/gpsController.js
const { getVehicleStatus } = require("../services/OptimizedGpsStatusService");
const { loginGps, sendGpsCommand, resetGpsToken } = require("../services/GpsService"); // ✅ Add resetGpsToken
const Voiture = require("../models/voiture");

exports.issueCommandToVehicle = async (req, res) => {
    console.log("📥 Received request to issue GPS command:", req.body);

    try {
        let { vehicleId, command, params = "", password = "", sendTime = "" } = req.body;

        // Validation
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

        // Get vehicle MAC from database
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["mac_id_gps"],
        });
        if (!vehicle || !vehicle.mac_id_gps) {
            return res.status(404).json({ success: false, message: "Vehicle or MAC not found" });
        }
        const macIdGps = vehicle.mac_id_gps;

        // ✅ LOGIN WITH RETRY LOGIC
        console.log("🔑 Logging into GPS provider…");
        let token = await loginGps();

        if (!token) {
            console.error("❌ GPS Login failed.");
            return res.status(401).json({ success: false, message: "Login failed" });
        }

        // ✅ SEND COMMAND WITH TOKEN REFRESH ON 403
        console.log(`📡 Sending ${command} → MAC ${macIdGps}`);
        let providerResp = await sendGpsCommand(macIdGps, command, params, password, sendTime, token);

        // ✅ If we get 403, token might be expired - refresh and retry ONCE
        if (providerResp && (providerResp.errorCode === '403' || providerResp.errorCode === 403)) {
            console.warn("⚠️ Got 403 error - Token might be expired. Refreshing token and retrying...");

            // Clear the old token
            resetGpsToken();

            // Get a fresh token
            token = await loginGps();
            if (!token) {
                console.error("❌ Token refresh failed");
                return res.status(401).json({
                    success: false,
                    message: "Token refresh failed"
                });
            }

            console.log("🔄 Retrying command with fresh token...");
            providerResp = await sendGpsCommand(macIdGps, command, params, password, sendTime, token);
        }

        // Check if command succeeded
        const ok =
            providerResp &&
            (providerResp.success === true ||
                providerResp.success === "true" ||
                providerResp.errorCode === "200");

        // Get return message from provider
        const first = Array.isArray(providerResp?.data) && providerResp.data.length
            ? providerResp.data[0]
            : {};
        const returnMsg = first?.ReturnMsg || providerResp?.errorDescribe || null;

        if (!ok) {
            console.error("❌ Command failed:", returnMsg || providerResp);
            return res.status(502).json({
                success: false,
                message: returnMsg || "Command failed",
                vehicleId,
                macIdGps,
                response: providerResp,
            });
        }

        // Return success response
        return res.json({
            success: true,
            message: `${command} sent`,
            vehicleId,
            macIdGps,
            response: providerResp,
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

        const macIdGps = vehicle.mac_id_gps;
        const carModel = vehicle.model;
        console.log(`✅ Found vehicle: ${carModel} (MAC: ${macIdGps})`);

        // Get status using 3-tier optimization
        console.log(`🔍 Fetching vehicle status...`);
        const status = await getVehicleStatus(parseInt(vehicleId), macIdGps);

        if (!status.success) {
            console.error(`❌ Failed to get status: ${status.error}`);
            return res.status(502).json({
                success: false,
                message: "Failed to retrieve vehicle status",
                error: status.error
            });
        }

        console.log(`✅ Status retrieved successfully!`);
        console.log(`   📊 Source: ${status.source}`);
        console.log(`   🔧 Engine: ${status.engineOn ? 'ON' : 'OFF'}`);
        console.log(`   🔌 ACC: ${status.accOn ? 'ON' : 'OFF'}`);
        console.log(`   📡 GPS Signal: ${status.gpsSignal}`);
        console.log(`   🏎️ Speed: ${status.speed} km/h`);

        if (status.dataAgeSeconds !== undefined) {
            console.log(`   ⏰ Data Age: ${status.dataAgeSeconds}s`);
        }

        console.log("========== REQUEST COMPLETED ==========\n");

        // Return standardized response
        return res.json({
            success: true,
            source: status.source,
            vehicleId: parseInt(vehicleId),
            macIdGps: macIdGps,
            carModel: carModel,
            engineOn: status.engineOn,
            accOn: status.accOn,
            gpsStatus: status.gpsSignal,
            speed: status.speed,
            latitude: status.latitude,
            longitude: status.longitude,
            lastUpdate: status.lastUpdate || status.deviceTime,
            rawStatus: status.rawStatus,
            dataAgeSeconds: status.dataAgeSeconds,
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