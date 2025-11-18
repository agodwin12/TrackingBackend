const { Alert } = require("../models");

// Fetch alerts for a specific vehicle
exports.getAlertsByVehicle = async (req, res) => {
    const { vehicleId } = req.params;

    try {
        const alerts = await Alert.findAll({
            where: { voiture_id: vehicleId },
            order: [["alerted_at", "DESC"]],
        });

        return res.status(200).json({
            success: true,
            count: alerts.length,
            data: alerts,
        });
    } catch (error) {
        console.error("🔥 Error fetching alerts:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching alerts",
            error: error.message,
        });
    }
};


exports.checkSafeZoneViolation = async (vehicleId, currentLat, currentLon) => {
    console.log(`🚨 CHECK SAFE ZONE VIOLATION: vehicle=${vehicleId}, lat=${currentLat}, lon=${currentLon}`);

    try {
        const safeZone = await SafeZone.findOne({
            where: {
                vehicle_id: vehicleId,
                is_active: true
            }
        });

        if (!safeZone) {
            console.log("ℹ️ No active safe zone for this vehicle");
            return { violation: false, safeZone: null };
        }

        const distance = calculateDistance(
            safeZone.center_latitude,
            safeZone.center_longitude,
            currentLat,
            currentLon
        );

        console.log(`📏 Distance from center: ${distance.toFixed(2)}m | Allowed: ${safeZone.radius_meters}m`);

        const isOutside = distance > safeZone.radius_meters;

        // ✅ Create alert when vehicle leaves safe zone
        if (isOutside && !safeZone.alert_triggered) {
            console.log("🚨 Vehicle OUTSIDE safe zone! Creating alert...");

            // Create alert in database
            await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'safe_zone',
                message: `⚠️ Vehicle left safe zone "${safeZone.name}"! Distance: ${Math.round(distance)}m from center`,
                alerted_at: new Date(),
                sent: false,
                read: false
            });

            safeZone.alert_triggered = true;
            safeZone.last_alert_at = new Date();
            await safeZone.save();

            console.log("✅ Safe zone alert created successfully");

            return {
                violation: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true
            };
        }

        // ✅ Create alert when vehicle returns to safe zone
        if (!isOutside && safeZone.alert_triggered) {
            console.log("✅ Vehicle is BACK inside safe zone — Creating return alert");

            await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'safe_zone',
                message: `✅ Vehicle returned to safe zone "${safeZone.name}"`,
                alerted_at: new Date(),
                sent: false,
                read: false
            });

            safeZone.alert_triggered = false;
            await safeZone.save();

            console.log("✅ Safe zone return alert created");
        }

        return {
            violation: isOutside,
            safeZone,
            distance: Math.round(distance),
            isFirstAlert: false
        };

    } catch (error) {
        console.error("🔥 Error during safe zone violation check:", error);
        return { violation: false, safeZone: null, error: error.message };
    }
};

// PATCH /api/alerts/:id/read
exports.markAlertAsRead = async (req, res) => {
    const { id } = req.params;

    try {
        const alert = await Alert.findByPk(id);

        if (!alert) {
            return res.status(404).json({
                success: false,
                message: "Alert not found",
            });
        }

        alert.read = true;
        await alert.save();

        return res.status(200).json({
            success: true,
            message: "Alert marked as read",
            data: alert,
        });
    } catch (error) {
        console.error("🔥 Error marking alert as read:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while updating alert",
            error: error.message,
        });
    }
};


// PATCH /api/alerts/vehicle/:vehicleId/read-all
exports.markAllAsRead = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const [count] = await Alert.update(
            { read: true },
            { where: { voiture_id: vehicleId } }
        );

        return res.status(200).json({
            success: true,
            message: `${count} alerts marked as read`,
        });
    } catch (error) {
        console.error("🔥 Error marking all alerts as read:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while marking alerts as read",
            error: error.message,
        });
    }
};

