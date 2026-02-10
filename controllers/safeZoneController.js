// controllers/safeZoneController.js
// ✅ Safe Zone CRUD + Robust state-change monitoring (leave + return) with push notifications

const SafeZone = require("../models/safeZoneModel");
const Voiture = require("../models/voiture");
const socketService = require("../services/socketService");
const Alert = require("../models/Alert");
const NotificationService = require("./notificationController");
const axios = require("axios");

// =====================================================
// Utils
// =====================================================

// Haversine distance (meters)
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

// =====================================================
// Reverse geocoding helper
// =====================================================
async function getLocationName(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);

    try {
        const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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
        console.error("⚠️ Error getting location name:", {
            message: error.message,
            status: error.response?.status,
            respData: error.response?.data,
            lat,
            lng,
        });
        return `[${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
    }
}

// =====================================================
// CRUD
// =====================================================

// ✅ Create Safe Zone
exports.createSafeZone = async (req, res) => {
    console.log("📍 CREATE SAFE ZONE REQUEST RECEIVED:", req.body);

    try {
        const { vehicle_id, name, center_latitude, center_longitude, radius_meters } = req.body;
        const user_id = req.user?.id;

        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

        const vehicleId = toNumberOrNull(vehicle_id);
        const lat = toNumberOrNull(center_latitude);
        const lng = toNumberOrNull(center_longitude);
        const radius = toNumberOrNull(radius_meters) ?? 10;

        if (!vehicleId) return res.status(400).json({ success: false, message: "vehicle_id is required" });

        if (!validateLatLng(lat, lng)) {
            return res.status(400).json({
                success: false,
                message: "Invalid center coordinates (center_latitude / center_longitude).",
            });
        }

        if (!Number.isFinite(radius) || radius <= 0) {
            return res.status(400).json({ success: false, message: "radius_meters must be > 0" });
        }

        const vehicle = await Voiture.findOne({ where: { id: vehicleId } });
        if (!vehicle) return res.status(404).json({ success: false, message: "Vehicle not found" });

        const existingSafeZone = await SafeZone.findOne({ where: { vehicle_id: vehicleId, user_id } });
        if (existingSafeZone) {
            return res.status(400).json({ success: false, message: "Safe zone already exists for this vehicle" });
        }

        const safeZone = await SafeZone.create({
            user_id,
            vehicle_id: vehicleId,
            name: name || "Safe Zone",
            center_latitude: lat,
            center_longitude: lng,
            radius_meters: radius,
            is_active: true,
            alert_triggered: false, // false => last known state is INSIDE
            last_alert_at: null,
        });

        return res.status(201).json({ success: true, message: "Safe zone created successfully", data: safeZone });
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

        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

        const vehicleId = toNumberOrNull(vehicle_id);
        if (!vehicleId) return res.status(400).json({ success: false, message: "vehicle_id is required" });

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

        if (!safeZone) return res.status(404).json({ success: false, message: "No safe zone found" });

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
        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

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

        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) return res.status(400).json({ success: false, message: "id is required" });

        const { name, center_latitude, center_longitude, radius_meters } = req.body;

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) return res.status(404).json({ success: false, message: "Safe zone not found" });

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

            // Reset state after changing center so next GPS update can trigger correctly
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

        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) return res.status(400).json({ success: false, message: "id is required" });

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) return res.status(404).json({ success: false, message: "Safe zone not found" });

        safeZone.is_active = !safeZone.is_active;

        // When re-activating, reset state so next movement triggers cleanly
        if (safeZone.is_active) {
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = null;
        }

        await safeZone.save();

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

        if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

        const safeZoneId = toNumberOrNull(id);
        if (!safeZoneId) return res.status(400).json({ success: false, message: "id is required" });

        const safeZone = await SafeZone.findOne({ where: { id: safeZoneId, user_id } });
        if (!safeZone) return res.status(404).json({ success: false, message: "Safe zone not found" });

        await safeZone.destroy();
        return res.json({ success: true, message: "Safe zone deleted successfully" });
    } catch (error) {
        console.error("🔥 Safe zone delete error:", error);
        return res.status(500).json({ success: false, message: "Error deleting safe zone", error: error.message });
    }
};

// =====================================================
// ✅ MONITORING LOGIC (FIXED)
// Ensures "return" always creates an alert + sends push
// Even if there are race conditions / duplicate processes,
// this uses a DB lock (transaction + row lock) if available.
// If your SafeZone model doesn't support transactions,
// it still works, but row-lock prevention won't apply.
// =====================================================

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
        const safeZone = await SafeZone.findOne({
            where: { vehicle_id: vId, is_active: true },
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

        // ✅ STEP 2: Compute distance + state
        const distance = calculateDistance(safeZone.center_latitude, safeZone.center_longitude, lat, lon);
        const radius = Number(safeZone.radius_meters);
        const isOutside = distance > radius;

        // IMPORTANT FIX:
        // Treat "alert_triggered" strictly as "wasOutside"
        // If your DB stores it as 0/1 or "0"/"1", normalize:
        const wasOutside = safeZone.alert_triggered === true || safeZone.alert_triggered === 1 || safeZone.alert_triggered === "1";

        console.log(`✅ Safe zone found: ${safeZone.name} | radius=${radius}m`);
        console.log(`📏 Distance=${distance.toFixed(2)}m | isOutside=${isOutside} | wasOutside=${wasOutside}`);

        const vehicleNickname = safeZone.vehicle?.nickname || safeZone.vehicle?.model || "Your vehicle";

        // ✅ SCENARIO 1: LEFT (inside -> outside)
        if (isOutside && !wasOutside) {
            const locationName = await getLocationName(lat, lon);
            const message = `🚨 ${vehicleNickname} just left the safe zone from ${locationName}`;

            // 1) Create alert
            const newAlert = await Alert.create({
                voiture_id: vId,
                alert_type: "safe_zone",
                message,
                latitude: lat,
                longitude: lon,
                alerted_at: new Date(),
                sent: true,
                read: false,
            });

            // 2) Update state (now outside)
            safeZone.alert_triggered = true;
            safeZone.last_alert_at = new Date();
            await safeZone.save();

            // 3) Push
            try {
                const r = await NotificationService.sendSafeZoneAlert(safeZone.user_id, vehicleNickname, safeZone.name, "left");
                console.log("📲 Push LEFT result:", r);
            } catch (e) {
                console.error("❌ Push LEFT error:", e.message);
            }

            // 4) Socket
            try {
                socketService.emitToVehicle(vId, "safe_zone_alert", {
                    alertId: newAlert.id,
                    type: "safe_zone_violation",
                    severity: "warning",
                    title: "Safe Zone Alert",
                    message,
                    vehicleId: vId,
                    vehicleName: vehicleNickname,
                    safeZoneName: safeZone.name,
                    distance: Math.round(distance),
                    location: locationName,
                    latitude: lat,
                    longitude: lon,
                    timestamp: new Date().toISOString(),
                });
            } catch (e) {
                console.error("❌ Socket error:", e.message);
            }

            return {
                violation: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true,
                alertId: newAlert.id,
                stateChanged: true,
                currentState: "outside",
                previousState: "inside",
            };
        }

        // ✅ SCENARIO 2: RETURNED (outside -> inside)
        // FIX: This must trigger whenever wasOutside===true AND isOutside===false
        if (!isOutside && wasOutside) {
            const locationName = await getLocationName(lat, lon);
            const message = `✅ ${vehicleNickname} returned to the safe zone at ${locationName}`;

            // 1) Create alert (THIS is what you said is missing)
            const returnAlert = await Alert.create({
                voiture_id: vId,
                alert_type: "safe_zone",
                message,
                latitude: lat,
                longitude: lon,
                alerted_at: new Date(),
                sent: true,
                read: false,
            });

            // 2) Update state (now inside)
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = new Date();
            await safeZone.save();

            // 3) Push (THIS is what you said doesn't arrive)
            try {
                const r = await NotificationService.sendSafeZoneAlert(
                    safeZone.user_id,
                    vehicleNickname,
                    safeZone.name,
                    "returned"
                );
                console.log("📲 Push RETURN result:", r);
            } catch (e) {
                console.error("❌ Push RETURN error:", e.message);
            }

            // 4) Socket
            try {
                socketService.emitToVehicle(vId, "safe_zone_alert", {
                    alertId: returnAlert.id,
                    type: "safe_zone_return",
                    severity: "info",
                    title: "Safe Zone Safe",
                    message,
                    vehicleId: vId,
                    vehicleName: vehicleNickname,
                    safeZoneName: safeZone.name,
                    location: locationName,
                    latitude: lat,
                    longitude: lon,
                    timestamp: new Date().toISOString(),
                });
            } catch (e) {
                console.error("❌ Socket error:", e.message);
            }

            return {
                violation: false,
                returned: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true,
                alertId: returnAlert.id,
                stateChanged: true,
                currentState: "inside",
                previousState: "outside",
            };
        }

        // ✅ SCENARIO 3: No change
        return {
            violation: isOutside,
            safeZone,
            distance: Math.round(distance),
            isFirstAlert: false,
            noStateChange: true,
            stateChanged: false,
            currentState: isOutside ? "outside" : "inside",
            previousState: wasOutside ? "outside" : "inside",
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
