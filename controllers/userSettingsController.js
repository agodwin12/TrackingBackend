// controllers/userSettingsController.js

const User = require("../models/userModel");

/**
 * Update trip tracking setting
 * PUT /api/users-settings/:userId/settings/trip-tracking
 */
exports.updateTripTracking = async (req, res) => {
    try {
        const { userId } = req.params;
        const { enabled } = req.body;

        console.log(`\n📌 [updateTripTracking] Request received`);
        console.log(`➡ User ID: ${userId}`);
        console.log(`➡ Enabled: ${enabled}`);

        if (typeof enabled !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "Invalid input: 'enabled' must be a boolean"
            });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        user.trip_tracking_enabled = enabled;
        await user.save();

        console.log(`✅ Trip tracking ${enabled ? "enabled" : "disabled"} for user ${userId}`);

        res.json({
            success: true,
            message: `Trip tracking ${enabled ? "enabled" : "disabled"} successfully`,
            data: {
                userId: user.id,
                tripTrackingEnabled: user.trip_tracking_enabled
            }
        });
    } catch (error) {
        console.error("🔥 ERROR in updateTripTracking:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

/**
 * Get user's current settings
 * GET /api/users-settings/:userId/settings
 */
exports.getUserSettings = async (req, res) => {
    try {
        const { userId } = req.params;

        console.log("\n📌 [getUserSettings] Request received");
        console.log("➡ User ID:", userId);

        const user = await User.findByPk(userId, {
            attributes: [
                'id',
                'nom',
                'prenom',
                'email',
                'phone',
                'trip_tracking_enabled',
                'geofence_alerts_enabled',
                'safe_zone_alerts_enabled'
            ]
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const settings = {
            tripTrackingEnabled: user.trip_tracking_enabled || false,
            geofenceAlertsEnabled: user.geofence_alerts_enabled !== false, // Default true
            safeZoneAlertsEnabled: user.safe_zone_alerts_enabled !== false, // Default true
        };

        console.log("✅ User settings retrieved for:", user.email);
        console.log("📋 Settings:", settings);

        res.json({
            success: true,
            data: {
                userId: user.id,
                name: `${user.prenom} ${user.nom}`,
                email: user.email,
                phone: user.phone,
                settings: settings
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in getUserSettings:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

/**
 * Update multiple user settings at once
 * PUT /api/users-settings/:userId/settings
 */
exports.updateUserSettings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { tripTrackingEnabled, geofenceAlertsEnabled, safeZoneAlertsEnabled } = req.body;

        console.log("\n📌 [updateUserSettings] Request received");
        console.log("➡ User ID:", userId);
        console.log("➡ Settings:", { tripTrackingEnabled, geofenceAlertsEnabled, safeZoneAlertsEnabled });

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Update settings
        if (typeof tripTrackingEnabled === "boolean") {
            user.trip_tracking_enabled = tripTrackingEnabled;
        }
        if (typeof geofenceAlertsEnabled === "boolean") {
            user.geofence_alerts_enabled = geofenceAlertsEnabled;
        }
        if (typeof safeZoneAlertsEnabled === "boolean") {
            user.safe_zone_alerts_enabled = safeZoneAlertsEnabled;
        }

        await user.save();

        console.log("✅ User settings updated successfully");

        res.json({
            success: true,
            message: "Settings updated successfully",
            data: {
                userId: user.id,
                settings: {
                    tripTrackingEnabled: user.trip_tracking_enabled,
                    geofenceAlertsEnabled: user.geofence_alerts_enabled,
                    safeZoneAlertsEnabled: user.safe_zone_alerts_enabled
                }
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in updateUserSettings:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

/**
 * ✅ Update alert settings (geofence and safe zone)
 * PUT /api/users-settings/:userId/settings/alerts
 */
exports.updateAlertSettings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { geofenceAlertsEnabled, safeZoneAlertsEnabled } = req.body;

        console.log("\n📌 [updateAlertSettings] Request received");
        console.log("➡ User ID:", userId);
        console.log("➡ Geofence Alerts:", geofenceAlertsEnabled);
        console.log("➡ Safe Zone Alerts:", safeZoneAlertsEnabled);

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Update alert settings
        if (typeof geofenceAlertsEnabled === "boolean") {
            user.geofence_alerts_enabled = geofenceAlertsEnabled;
        }
        if (typeof safeZoneAlertsEnabled === "boolean") {
            user.safe_zone_alerts_enabled = safeZoneAlertsEnabled;
        }

        await user.save();

        console.log("✅ Alert settings updated successfully");

        res.json({
            success: true,
            message: "Alert settings updated successfully",
            data: {
                userId: user.id,
                settings: {
                    tripTrackingEnabled: user.trip_tracking_enabled,
                    geofenceAlertsEnabled: user.geofence_alerts_enabled,
                    safeZoneAlertsEnabled: user.safe_zone_alerts_enabled
                }
            }
        });

    } catch (error) {
        console.error("🔥 ERROR in updateAlertSettings:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};

module.exports = exports;
