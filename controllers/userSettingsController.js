const User = require("../models/userModel");

exports.updateTripTracking = async (req, res) => {
    try {
        const { userId } = req.params;
        const { enabled } = req.body;

        if (typeof enabled !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "Invalid input: 'enabled' must be a boolean"
            });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        user.trip_tracking_enabled = enabled;
        await user.save();

        res.json({
            success: true,
            message: `Trip tracking ${enabled ? "enabled" : "disabled"} successfully`,
            data: { userId: user.id, tripTrackingEnabled: user.trip_tracking_enabled }
        });
    } catch (error) {
        console.error("ERROR:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

exports.getUserSettings = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        res.json({
            success: true,
            data: {
                userId: user.id,
                name: `${user.prenom} ${user.nom}`,
                email: user.email,
                settings: { tripTrackingEnabled: user.trip_tracking_enabled || false }
            }
        });
    } catch (error) {
        console.error("ERROR:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

exports.updateUserSettings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { tripTrackingEnabled } = req.body;

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (typeof tripTrackingEnabled === "boolean") {
            user.trip_tracking_enabled = tripTrackingEnabled;
        }

        await user.save();

        res.json({
            success: true,
            message: "Settings updated successfully",
            data: { userId: user.id, settings: { tripTrackingEnabled: user.trip_tracking_enabled } }
        });
    } catch (error) {
        console.error("ERROR:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};
/**
 * Get user's current settings
 * GET /api/users/:userId/settings
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
                'created_at',
                'updated_at'
            ]
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        console.log("✅ User settings retrieved for:", user.email);

        res.json({
            success: true,
            data: {
                userId: user.id,
                name: `${user.prenom} ${user.nom}`,
                email: user.email,
                phone: user.phone,
                settings: {
                    tripTrackingEnabled: user.trip_tracking_enabled || false
                },
                updatedAt: user.updated_at
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
 * PUT /api/users/:userId/settings
 */
exports.updateUserSettings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { tripTrackingEnabled } = req.body;

        console.log("\n📌 [updateUserSettings] Request received");
        console.log("➡ User ID:", userId);

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        if (typeof tripTrackingEnabled === "boolean") {
            user.trip_tracking_enabled = tripTrackingEnabled;
        }

        await user.save();

        console.log("✅ User settings updated");

        res.json({
            success: true,
            message: "Settings updated successfully",
            data: {
                userId: user.id,
                settings: {
                    tripTrackingEnabled: user.trip_tracking_enabled
                },
                updatedAt: user.updated_at
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