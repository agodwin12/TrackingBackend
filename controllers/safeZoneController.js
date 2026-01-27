// controllers/safeZoneController.js

const SafeZone = require("../models/safeZoneModel");
const Voiture = require("../models/voiture");
const socketService = require("../services/socketService");
const Alert = require("../models/Alert");
const NotificationService = require("./notificationController");
const axios = require("axios");

// Helper function to calculate distance using Haversine formula (meters)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = (Number(lat1) * Math.PI) / 180;
    const φ2 = (Number(lat2) * Math.PI) / 180;
    const Δφ = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
    const Δλ = ((Number(lon2) - Number(lon1)) * Math.PI) / 180;

    const a =
        Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// ✅ Helper function to get location name from coordinates (reverse geocoding)
async function getLocationName(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);

    try {
        const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

        // Avoid hard-coded keys (debug-friendly + safer)
        if (!GOOGLE_MAPS_API_KEY) {
            console.warn("⚠️ GOOGLE_MAPS_API_KEY is missing in environment. Returning coordinates.");
            return `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
        }

        const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
            params: {
                latlng: `${lat},${lng}`,
                key: GOOGLE_MAPS_API_KEY,
                language: "en",
            },
            timeout: 7000,
        });

        const data = response.data;

        if (data.status !== "OK") {
            console.warn("⚠️ Geocoding failed:", {
                status: data.status,
                error_message: data.error_message,
                lat,
                lng,
            });
            return `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
        }

        if (!data.results || data.results.length === 0) {
            return `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
        }

        const result = data.results[0];
        const addressComponents = result.address_components || [];

        let locality = "";
        let route = "";
        let neighborhood = "";

        for (const component of addressComponents) {
            if (component.types?.includes("locality")) locality = component.long_name;
            if (component.types?.includes("route")) route = component.short_name || component.long_name;
            if (
                component.types?.includes("neighborhood") ||
                component.types?.includes("sublocality") ||
                component.types?.includes("sublocality_level_1")
            ) {
                neighborhood = component.long_name;
            }
        }

        if (route && locality) return `${route}, ${locality}`;
        if (neighborhood && locality) return `${neighborhood}, ${locality}`;
        if (locality) return locality;

        return result.formatted_address || `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
    } catch (error) {
        const status = error.response?.status;
        const respData = error.response?.data;

        console.error("⚠️ Error getting location name:", {
            message: error.message,
            status,
            respData,
            lat,
            lng,
        });

        return `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
    }
}

// Small helpers
const toNumberOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const validateLatLng = (lat, lng) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (Math.abs(lat) > 90) return false;
    if (Math.abs(lng) > 180) return false;
    return true;
};

// ✅ Create Safe Zone
exports.createSafeZone = async (req, res) => {
    console.log("📍 CREATE SAFE ZONE REQUEST RECEIVED:", req.body);

    try {
        const { vehicle_id, name, center_latitude, center_longitude, radius_meters } = req.body;
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const vehicleId = toNumberOrNull(vehicle_id);
        const lat = toNumberOrNull(center_latitude);
        const lng = toNumberOrNull(center_longitude);
        const radius = toNumberOrNull(radius_meters) ?? 10;

        if (!vehicleId) {
            return res.status(400).json({ success: false, message: "vehicle_id is required" });
        }

        if (!validateLatLng(lat, lng)) {
            return res.status(400).json({
                success: false,
                message: "Invalid center coordinates (center_latitude / center_longitude).",
            });
        }

        if (!Number.isFinite(radius) || radius <= 0) {
            return res.status(400).json({ success: false, message: "radius_meters must be > 0" });
        }

        console.log(`🔍 Checking vehicle: vehicle=${vehicleId}`);

        const vehicle = await Voiture.findOne({ where: { id: vehicleId } });
        if (!vehicle) {
            console.log("❌ Vehicle not found");
            return res.status(404).json({ success: false, message: "Vehicle not found" });
        }

        const existingSafeZone = await SafeZone.findOne({ where: { vehicle_id: vehicleId, user_id } });
        if (existingSafeZone) {
            console.log("⚠️ Safe zone already exists:", existingSafeZone.dataValues);
            return res
                .status(400)
                .json({ success: false, message: "Safe zone already exists for this vehicle" });
        }

        const safeZone = await SafeZone.create({
            user_id,
            vehicle_id: vehicleId,
            name: name || "Safe Zone",
            center_latitude: lat,
            center_longitude: lng,
            radius_meters: radius,
            is_active: true,
            alert_triggered: false,
            last_alert_at: null,
        });

        console.log("✅ Safe zone created:", safeZone.dataValues);

        return res
            .status(201)
            .json({ success: true, message: "Safe zone created successfully", data: safeZone });
    } catch (error) {
        console.error("🔥 Error creating safe zone:", error);
        return res.status(500).json({ success: false, message: "Error creating safe zone", error: error.message });
    }
};

// ✅ Get Safe Zone by Vehicle
exports.getSafeZone = async (req, res) => {
    console.log("📍 GET SAFE ZONE REQUEST:", req.params);

    try {
        const { vehicle_id } = req.params;
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const vehicleId = toNumberOrNull(vehicle_id);
        if (!vehicleId) {
            return res.status(400).json({ success: false, message: "vehicle_id is required" });
        }

        const safeZone = await SafeZone.findOne({
            where: { vehicle_id: vehicleId, user_id },
            include: [
                {
                    model: Voiture,
                    attributes: ["id", "model", "immatriculation", "mac_id_gps"],
                    as: "vehicle",
                },
            ],
        });

        if (!safeZone) {
            console.log("❌ No safe zone found");
            return res.status(404).json({ success: false, message: "No safe zone found" });
        }

        console.log("✅ Safe zone found:", safeZone.dataValues);
        return res.json({ success: true, data: safeZone });
    } catch (error) {
        console.error("🔥 Error fetching safe zone:", error);
        return res.status(500).json({ success: false, message: "Error fetching safe zone", error: error.message });
    }
};

// ✅ Get All Safe Zones
exports.getAllSafeZones = async (req, res) => {
    console.log("📍 GET ALL SAFE ZONES REQUEST");

    try {
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const safeZones = await SafeZone.findAll({
            where: { user_id },
            include: [
                {
                    model: Voiture,
                    attributes: ["id", "model", "immatriculation", "mac_id_gps"],
                    as: "vehicle",
                },
            ],
            order: [["created_at", "DESC"]],
        });

        console.log(`✅ Retrieved ${safeZones.length} safe zones`);
        return res.json({ success: true, count: safeZones.length, data: safeZones });
    } catch (error) {
        console.error("🔥 Fetch all safe zones error:", error);
        return res.status(500).json({ success: false, message: "Error fetching safe zones", error: error.message });
    }
};

// ✅ Update Safe Zone
exports.updateSafeZone = async (req, res) => {
    console.log("✏️ UPDATE SAFE ZONE REQUEST:", req.params, req.body);

    try {
        const { id } = req.params;
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) {
            return res.status(400).json({ success: false, message: "id is required" });
        }

        const { name, center_latitude, center_longitude, radius_meters } = req.body;

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: "Safe zone not found" });
        }

        const lat = center_latitude !== undefined ? toNumberOrNull(center_latitude) : null;
        const lng = center_longitude !== undefined ? toNumberOrNull(center_longitude) : null;
        const radius = radius_meters !== undefined ? toNumberOrNull(radius_meters) : null;

        if (name !== undefined) safeZone.name = name;

        // If either coordinate is provided, both must be valid
        if (center_latitude !== undefined || center_longitude !== undefined) {
            if (!validateLatLng(lat, lng)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid center coordinates (center_latitude / center_longitude).",
                });
            }
            safeZone.center_latitude = lat;
            safeZone.center_longitude = lng;

            // Reset state after changing center
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = null;
        }

        if (radius !== null) {
            if (!Number.isFinite(radius) || radius <= 0) {
                return res.status(400).json({ success: false, message: "radius_meters must be > 0" });
            }
            safeZone.radius_meters = radius;
        }

        await safeZone.save();

        console.log("✅ Safe zone updated:", safeZone.dataValues);
        return res.json({ success: true, message: "Safe zone updated successfully", data: safeZone });
    } catch (error) {
        console.error("🔥 Error updating safe zone:", error);
        return res.status(500).json({ success: false, message: "Error updating safe zone", error: error.message });
    }
};

// ✅ Toggle Safe Zone
exports.toggleSafeZone = async (req, res) => {
    console.log("🔄 TOGGLE SAFE ZONE REQUEST:", req.params);

    try {
        const { id } = req.params;
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) {
            return res.status(400).json({ success: false, message: "id is required" });
        }

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: "Safe zone not found" });
        }

        safeZone.is_active = !safeZone.is_active;

        if (safeZone.is_active) {
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = null;
        }

        await safeZone.save();

        console.log(`✅ Safe zone is now: ${safeZone.is_active ? "🟢 ACTIVE" : "🔴 INACTIVE"}`);
        return res.json({
            success: true,
            message: `Safe zone ${safeZone.is_active ? "activated" : "deactivated"}`,
            data: safeZone,
        });
    } catch (error) {
        console.error("🔥 Error toggling safe zone:", error);
        return res.status(500).json({ success: false, message: "Error toggling safe zone", error: error.message });
    }
};

// ✅ Delete Safe Zone
exports.deleteSafeZone = async (req, res) => {
    console.log("🗑️ DELETE SAFE ZONE REQUEST:", req.params);

    try {
        const { id } = req.params;
        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) {
            return res.status(400).json({ success: false, message: "id is required" });
        }

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: "Safe zone not found" });
        }

        await safeZone.destroy();
        console.log("✅ Safe zone deleted:", safeZoneId);
        return res.json({ success: true, message: "Safe zone deleted successfully" });
    } catch (error) {
        console.error("🔥 Safe zone delete error:", error);
        return res.status(500).json({ success: false, message: "Error deleting safe zone", error: error.message });
    }
};

// ✅ Safe Zone Check - ONLY Alert on State Change
exports.checkSafeZoneViolation = async (vehicleId, currentLat, currentLon) => {
    console.log(`\n========================================`);
    console.log(`🚨 SAFE ZONE CHECK STARTED`);
    console.log(`========================================`);
    console.log(`🚗 Vehicle ID: ${vehicleId}`);
    console.log(`📍 Current Position: [${currentLat}, ${currentLon}]`);

    try {
        const vId = toNumberOrNull(vehicleId);
        const lat = toNumberOrNull(currentLat);
        const lon = toNumberOrNull(currentLon);

        if (!vId || !validateLatLng(lat, lon)) {
            console.log("⚠️ Invalid inputs for safe zone check");
            console.log(`========================================\n`);
            return { violation: false, safeZone: null, error: "Invalid inputs" };
        }

        // ✅ STEP 1: Fetch safe zone
        console.log(`\n🔍 STEP 1: Fetching safe zone from database...`);
        const safeZone = await SafeZone.findOne({
            where: {
                vehicle_id: vId,
                is_active: true,
            },
            include: [
                {
                    model: Voiture,
                    as: "vehicle",
                    attributes: ["id", "model", "immatriculation", "nickname"],
                },
            ],
        });

        if (!safeZone) {
            console.log("ℹ️  No active safe zone configured for this vehicle");
            console.log(`========================================\n`);
            return { violation: false, safeZone: null };
        }

        console.log(`✅ Safe zone found!`);
        console.log(`   ID: ${safeZone.id}`);
        console.log(`   Name: ${safeZone.name}`);
        console.log(`   Center: [${safeZone.center_latitude}, ${safeZone.center_longitude}]`);
        console.log(`   Radius: ${safeZone.radius_meters}m`);
        console.log(`   Previous State: ${safeZone.alert_triggered ? "🔴 WAS OUTSIDE" : "🟢 WAS INSIDE"}`);
        console.log(`   User ID: ${safeZone.user_id}`);

        // ✅ STEP 2: Calculate distance
        console.log(`\n🔍 STEP 2: Calculating distance...`);
        const distance = calculateDistance(
            safeZone.center_latitude,
            safeZone.center_longitude,
            lat,
            lon
        );

        console.log(`📏 Distance from center: ${distance.toFixed(2)}m`);
        console.log(`📏 Safe zone radius: ${safeZone.radius_meters}m`);

        // ✅ Determine current state
        const isOutside = distance > Number(safeZone.radius_meters);
        const wasOutside = !!safeZone.alert_triggered;

        console.log(`🎯 Current Status: Vehicle is ${isOutside ? "🔴 OUTSIDE" : "🟢 INSIDE"} safe zone`);

        // ✅ STEP 3: STATE CHANGE DETECTION
        console.log(`\n🔍 STEP 3: Checking for state changes...`);
        console.log(`   Was outside before: ${wasOutside ? "✅ YES" : "❌ NO"}`);
        console.log(`   Is outside now: ${isOutside ? "✅ YES" : "❌ NO"}`);

        // ========================================
        // 🚨 SCENARIO 1: Vehicle JUST LEFT safe zone
        // ========================================
        if (isOutside && !wasOutside) {
            console.log(`\n========================================`);
            console.log(`🚨 STATE CHANGE DETECTED: LEFT SAFE ZONE!`);
            console.log(`========================================`);
            console.log(`🔄 Transition: INSIDE → OUTSIDE`);
            console.log(`📏 Distance: ${Math.round(distance)}m (limit: ${safeZone.radius_meters}m)`);

            const vehicleNickname = safeZone.vehicle?.nickname || safeZone.vehicle?.model || "Your vehicle";
            const locationName = await getLocationName(lat, lon);

            const alertMessage = `🚨 ${vehicleNickname} just left the safe zone from ${locationName}`;
            console.log(`📝 Alert message: "${alertMessage}"`);

            // Create alert in DB
            const newAlert = await Alert.create({
                voiture_id: vId,
                alert_type: "safe_zone",
                message: alertMessage,
                latitude: lat,
                longitude: lon,
                alerted_at: new Date(),
                sent: true,
                read: false,
            });
            console.log(`✅ Alert created in database: ID=${newAlert.id}`);

            // Update safe zone state to "outside"
            safeZone.alert_triggered = true;
            safeZone.last_alert_at = new Date();
            await safeZone.save();
            console.log(`✅ Safe zone state updated: alert_triggered = TRUE (outside)`);

            // Push notification
            try {
                console.log(`📤 Sending push notification...`);
                const notificationResult = await NotificationService.sendSafeZoneAlert(
                    safeZone.user_id,
                    vehicleNickname,
                    safeZone.name,
                    "left"
                );

                if (notificationResult?.success) {
                    console.log(`✅ Push notification sent successfully (${notificationResult.successCount} devices)`);
                } else {
                    console.log(`⚠️  Push notification failed`);
                }
            } catch (notifError) {
                console.error(`❌ Push notification error:`, notifError.message);
            }

            // Socket.IO event
            try {
                socketService.emitToVehicle(vId, "safe_zone_alert", {
                    alertId: newAlert.id,
                    type: "safe_zone_violation",
                    severity: "warning",
                    title: "Safe Zone Alert",
                    message: alertMessage,
                    vehicleId: vId,
                    vehicleName: vehicleNickname,
                    safeZoneName: safeZone.name,
                    distance: Math.round(distance),
                    location: locationName,
                    latitude: lat,
                    longitude: lon,
                    timestamp: new Date().toISOString(),
                });
                console.log(`✅ Socket.IO event emitted`);
            } catch (socketError) {
                console.error(`❌ Socket.IO error:`, socketError.message);
            }

            console.log(`========================================\n`);
            return {
                violation: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true,
                alertId: newAlert.id,
            };
        }

        // ========================================
        // ✅ SCENARIO 2: Vehicle JUST RETURNED to safe zone
        // ========================================
        if (!isOutside && wasOutside) {
            console.log(`\n========================================`);
            console.log(`✅ STATE CHANGE DETECTED: RETURNED TO SAFE ZONE!`);
            console.log(`========================================`);
            console.log(`🔄 Transition: OUTSIDE → INSIDE`);
            console.log(`📏 Distance: ${Math.round(distance)}m (threshold: ${safeZone.radius_meters}m)`);

            const vehicleNickname = safeZone.vehicle?.nickname || safeZone.vehicle?.model || "Your vehicle";
            const locationName = await getLocationName(lat, lon);

            const returnMessage = `✅ ${vehicleNickname} returned to the safe zone at ${locationName}`;
            console.log(`📝 Alert message: "${returnMessage}"`);

            const returnAlert = await Alert.create({
                voiture_id: vId,
                alert_type: "safe_zone",
                message: returnMessage,
                latitude: lat,
                longitude: lon,
                alerted_at: new Date(),
                sent: true,
                read: false,
            });
            console.log(`✅ Alert created in database: ID=${returnAlert.id}`);

            // Update state to inside
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = new Date();
            await safeZone.save();
            console.log(`✅ Safe zone state updated: alert_triggered = FALSE (inside)`);

            // Push notification
            try {
                console.log(`📤 Sending push notification...`);
                const notificationResult = await NotificationService.sendSafeZoneAlert(
                    safeZone.user_id,
                    vehicleNickname,
                    safeZone.name,
                    "returned"
                );

                if (notificationResult?.success) {
                    console.log(`✅ Push notification sent successfully (${notificationResult.successCount} devices)`);
                } else {
                    console.log(`⚠️  Push notification failed`);
                }
            } catch (notifError) {
                console.error(`❌ Push notification error:`, notifError.message);
            }

            // Socket.IO event
            try {
                socketService.emitToVehicle(vId, "safe_zone_alert", {
                    alertId: returnAlert.id,
                    type: "safe_zone_return",
                    severity: "info",
                    title: "Safe Zone Safe",
                    message: returnMessage,
                    vehicleId: vId,
                    vehicleName: vehicleNickname,
                    safeZoneName: safeZone.name,
                    location: locationName,
                    latitude: lat,
                    longitude: lon,
                    timestamp: new Date().toISOString(),
                });
                console.log(`✅ Socket.IO event emitted`);
            } catch (socketError) {
                console.error(`❌ Socket.IO error:`, socketError.message);
            }

            console.log(`========================================\n`);
            return {
                violation: false,
                returned: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true,
                alertId: returnAlert.id,
            };
        }

        // ========================================
        // ℹ️  SCENARIO 3: NO STATE CHANGE
        // ========================================
        console.log(`\n========================================`);
        console.log(`ℹ️  NO STATE CHANGE - NO ACTION NEEDED`);
        console.log(`========================================`);
        console.log(`📊 Status: Vehicle remains ${isOutside ? "🔴 OUTSIDE" : "🟢 INSIDE"} safe zone`);
        console.log(`📏 Distance: ${Math.round(distance)}m`);
        console.log(`⏭️  Skipping alert (already notified)`);
        console.log(`========================================\n`);

        return {
            violation: isOutside,
            safeZone,
            distance: Math.round(distance),
            isFirstAlert: false,
            noStateChange: true,
        };
    } catch (error) {
        console.error(`\n========================================`);
        console.error(`❌ SAFE ZONE CHECK ERROR`);
        console.error(`========================================`);
        console.error(`Error message:`, error.message);
        console.error(`Stack trace:`, error.stack);
        console.error(`========================================\n`);
        return { violation: false, safeZone: null, error: error.message };
    }
};

module.exports = exports;
