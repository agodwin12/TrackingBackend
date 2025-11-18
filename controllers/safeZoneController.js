// controllers/safeZoneController.js
const SafeZone = require('../models/safeZoneModel');
const Voiture = require('../models/Voiture');
const socketService = require('../services/socketService');
const Alert = require('../models/Alert');
const NotificationService = require('../services/notificationService'); // ✅ ADD THIS

// Helper function to calculate distance using Haversine formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// ✅ Create Safe Zone
exports.createSafeZone = async (req, res) => {
    console.log("📍 CREATE SAFE ZONE REQUEST RECEIVED:", req.body);

    try {
        const { vehicle_id, name, center_latitude, center_longitude, radius_meters } = req.body;
        const user_id = req.user.id;
        console.log(`🔍 Checking vehicle: vehicle=${vehicle_id}`);

        const vehicle = await Voiture.findOne({ where: { id: vehicle_id } });

        if (!vehicle) {
            console.log("❌ Vehicle not found");
            return res.status(404).json({ success: false, message: 'Vehicle not found' });
        }

        const existingSafeZone = await SafeZone.findOne({ where: { vehicle_id, user_id } });
        if (existingSafeZone) {
            console.log("⚠️ Safe zone already exists:", existingSafeZone.dataValues);
            return res.status(400).json({ success: false, message: 'Safe zone already exists for this vehicle' });
        }

        const safeZone = await SafeZone.create({
            user_id,
            vehicle_id,
            name: name || 'Safe Zone',
            center_latitude,
            center_longitude,
            radius_meters: radius_meters || 10,
            is_active: true,
            alert_triggered: false
        });

        console.log("✅ Safe zone created:", safeZone.dataValues);

        res.status(201).json({ success: true, message: 'Safe zone created successfully', data: safeZone });

    } catch (error) {
        console.error("🔥 Error creating safe zone:", error);
        res.status(500).json({ success: false, message: 'Error creating safe zone', error: error.message });
    }
};

// ✅ Get Safe Zone by Vehicle
exports.getSafeZone = async (req, res) => {
    console.log("📍 GET SAFE ZONE REQUEST:", req.params);

    try {
        const { vehicle_id } = req.params;
        const user_id = req.user.id;

        const safeZone = await SafeZone.findOne({
            where: { vehicle_id, user_id },
            include: [{
                model: Voiture,
                attributes: ['id', 'model', 'immatriculation', 'mac_id_gps'],
                as: 'vehicle'
            }]
        });

        if (!safeZone) {
            console.log("❌ No safe zone found");
            return res.status(404).json({ success: false, message: 'No safe zone found' });
        }

        console.log("✅ Safe zone found:", safeZone.dataValues);
        res.json({ success: true, data: safeZone });

    } catch (error) {
        console.error("🔥 Error fetching safe zone:", error);
        res.status(500).json({ success: false, message: 'Error fetching safe zone', error: error.message });
    }
};

// ✅ Get All Safe Zones
exports.getAllSafeZones = async (req, res) => {
    console.log("📍 GET ALL SAFE ZONES REQUEST");

    try {
        const user_id = req.user.id;
        const safeZones = await SafeZone.findAll({
            where: { user_id },
            include: [{
                model: Voiture,
                attributes: ['id', 'model', 'immatriculation', 'mac_id_gps'],
                as: 'vehicle'
            }],
            order: [['created_at', 'DESC']]
        });

        console.log(`✅ Retrieved ${safeZones.length} safe zones`);
        res.json({ success: true, count: safeZones.length, data: safeZones });

    } catch (error) {
        console.error("🔥 Fetch all safe zones error:", error);
        res.status(500).json({ success: false, message: 'Error fetching safe zones', error: error.message });
    }
};

// ✅ Update Safe Zone
exports.updateSafeZone = async (req, res) => {
    console.log("✏️ UPDATE SAFE ZONE REQUEST:", req.params, req.body);

    try {
        const { id } = req.params;
        const user_id = req.user.id;
        const { name, center_latitude, center_longitude, radius_meters } = req.body;

        const safeZone = await SafeZone.findOne({ where: { id, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: 'Safe zone not found' });
        }

        if (name !== undefined) safeZone.name = name;
        if (center_latitude !== undefined) safeZone.center_latitude = center_latitude;
        if (center_longitude !== undefined) safeZone.center_longitude = center_longitude;
        if (radius_meters !== undefined) safeZone.radius_meters = radius_meters;

        if (center_latitude !== undefined || center_longitude !== undefined) {
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = null;
        }

        await safeZone.save();

        console.log("✅ Safe zone updated:", safeZone.dataValues);
        res.json({ success: true, message: 'Safe zone updated successfully', data: safeZone });

    } catch (error) {
        console.error("🔥 Error updating safe zone:", error);
        res.status(500).json({ success: false, message: 'Error updating safe zone', error: error.message });
    }
};

// ✅ Toggle Safe Zone
exports.toggleSafeZone = async (req, res) => {
    console.log("🔄 TOGGLE SAFE ZONE REQUEST:", req.params);

    try {
        const { id } = req.params;
        const user_id = req.user.id;

        const safeZone = await SafeZone.findOne({ where: { id, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: 'Safe zone not found' });
        }

        safeZone.is_active = !safeZone.is_active;

        if (safeZone.is_active) {
            safeZone.alert_triggered = false;
            safeZone.last_alert_at = null;
        }

        await safeZone.save();

        console.log(`✅ Safe zone is now: ${safeZone.is_active ? '🟢 ACTIVE' : '🔴 INACTIVE'}`);
        res.json({ success: true, message: `Safe zone ${safeZone.is_active ? 'activated' : 'deactivated'}`, data: safeZone });

    } catch (error) {
        console.error("🔥 Error toggling safe zone:", error);
        res.status(500).json({ success: false, message: 'Error toggling safe zone', error: error.message });
    }
};

// ✅ Delete Safe Zone
exports.deleteSafeZone = async (req, res) => {
    console.log("🗑️ DELETE SAFE ZONE REQUEST:", req.params);

    try {
        const { id } = req.params;
        const user_id = req.user.id;

        const safeZone = await SafeZone.findOne({ where: { id, user_id } });
        if (!safeZone) {
            console.log("❌ Safe zone not found");
            return res.status(404).json({ success: false, message: 'Safe zone not found' });
        }

        await safeZone.destroy();
        console.log("✅ Safe zone deleted:", id);
        res.json({ success: true, message: 'Safe zone deleted successfully' });

    } catch (error) {
        console.error("🔥 Safe zone delete error:", error);
        res.status(500).json({ success: false, message: 'Error deleting safe zone', error: error.message });
    }
};

// ✅ Safe Zone Violation Check with PUSH NOTIFICATIONS
exports.checkSafeZoneViolation = async (vehicleId, currentLat, currentLon) => {
    console.log(`🚨 CHECK SAFE ZONE VIOLATION: vehicle=${vehicleId}, lat=${currentLat}, lon=${currentLon}`);

    try {
        const safeZone = await SafeZone.findOne({
            where: {
                vehicle_id: vehicleId,
                is_active: true
            },
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'model', 'immatriculation']
            }]
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

        // ✅ Vehicle LEFT safe zone - send alert
        if (isOutside && !safeZone.alert_triggered) {
            console.log(`🚨 Vehicle OUTSIDE safe zone! Creating ONE-TIME alert...`);

            safeZone.alert_triggered = true;
            safeZone.last_alert_at = new Date();
            await safeZone.save();
            console.log(`✅ Safe zone alert flag set to TRUE`);

            const vehicleName = safeZone.vehicle?.model || 'Vehicle';
            const alertMessage = `⚠️ ${vehicleName} left safe zone "${safeZone.name}"! Distance: ${Math.round(distance)}m from center`;

            // Create alert in database
            const newAlert = await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'safe_zone',
                message: alertMessage,
                alerted_at: new Date(),
                sent: false,
                read: false
            });
            console.log(`✅ Alert created in database: ID=${newAlert.id}`);

            // ✅ Send PUSH NOTIFICATION via FCM
            try {
                await NotificationService.sendSafeZoneAlert(
                    safeZone.user_id,
                    vehicleName,
                    safeZone.name
                );
                console.log(`📱 Push notification sent to user ${safeZone.user_id}`);
            } catch (notifError) {
                console.error(`⚠️ Failed to send push notification:`, notifError);
            }

            // Emit real-time notification via Socket.IO
            socketService.emitToVehicle(vehicleId, 'safe_zone_alert', {
                alertId: newAlert.id,
                type: 'safe_zone_violation',
                severity: 'warning',
                title: 'Safe Zone Alert',
                message: alertMessage,
                vehicleId: vehicleId,
                vehicleName: vehicleName,
                safeZoneName: safeZone.name,
                distance: Math.round(distance),
                timestamp: new Date().toISOString()
            });

            console.log(`✅ Safe zone violation alert created and broadcasted (ONE TIME ONLY)`);

            return {
                violation: true,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true
            };
        }

        // ✅ Vehicle RETURNED to safe zone
        if (!isOutside && safeZone.alert_triggered) {
            console.log(`✅ Vehicle is BACK inside safe zone — Creating return alert`);

            safeZone.alert_triggered = false;
            await safeZone.save();
            console.log(`✅ Safe zone alert flag reset to FALSE`);

            const vehicleName = safeZone.vehicle?.model || 'Vehicle';
            const returnMessage = `✅ ${vehicleName} returned to safe zone "${safeZone.name}"`;

            const returnAlert = await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'safe_zone',
                message: returnMessage,
                alerted_at: new Date(),
                sent: false,
                read: false
            });

            // ✅ Send PUSH NOTIFICATION for return
            try {
                await NotificationService.sendToUser(safeZone.user_id, {
                    title: '✅ Safe Zone Return',
                    body: returnMessage,
                    data: {
                        type: 'safe_zone',
                        event: 'return',
                        zone_name: safeZone.name,
                        timestamp: new Date().toISOString()
                    }
                });
                console.log(`📱 Push notification sent for safe zone return`);
            } catch (notifError) {
                console.error(`⚠️ Failed to send return push notification:`, notifError);
            }

            // Emit real-time notification
            socketService.emitToVehicle(vehicleId, 'safe_zone_alert', {
                alertId: returnAlert.id,
                type: 'safe_zone_return',
                severity: 'info',
                title: 'Safe Zone Alert',
                message: returnMessage,
                vehicleId: vehicleId,
                vehicleName: vehicleName,
                safeZoneName: safeZone.name,
                timestamp: new Date().toISOString()
            });

            console.log(`✅ Safe zone return alert created (ONE TIME ONLY)`);
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


module.exports = exports;