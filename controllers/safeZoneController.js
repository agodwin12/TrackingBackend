// controllers/safeZoneController.js
const SafeZone = require('../models/safeZoneModel');
const Voiture = require('../models/voiture');
const socketService = require('../services/socketService');
const Alert = require('../models/Alert');
const NotificationService = require('./notificationController');
const axios = require('axios');

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

// ✅ Helper function to get location name from coordinates
async function getLocationName(latitude, longitude) {
    try {
        const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyBn88TP5X-xaRCYo5gYxvGnVy_0WYotZWo';

        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                latlng: `${latitude},${longitude}`,
                key: GOOGLE_MAPS_API_KEY,
                language: 'en'
            },
            timeout: 5000
        });

        if (response.data.status === 'OK' && response.data.results.length > 0) {
            // Try to get a readable location from the results
            const result = response.data.results[0];

            // Look for specific components
            const addressComponents = result.address_components;
            let locality = '';
            let route = '';
            let neighborhood = '';

            for (const component of addressComponents) {
                if (component.types.includes('locality')) {
                    locality = component.long_name;
                }
                if (component.types.includes('route')) {
                    route = component.short_name;
                }
                if (component.types.includes('neighborhood') || component.types.includes('sublocality')) {
                    neighborhood = component.long_name;
                }
            }

            // Build location string
            if (route && locality) {
                return `${route}, ${locality}`;
            } else if (neighborhood && locality) {
                return `${neighborhood}, ${locality}`;
            } else if (locality) {
                return locality;
            } else {
                // Fall back to formatted address
                return result.formatted_address;
            }
        }

        return `[${latitude.toFixed(5)}, ${longitude.toFixed(5)}]`;
    } catch (error) {
        console.error('⚠️ Error getting location name:', error.message);
        return `[${latitude.toFixed(5)}, ${longitude.toFixed(5)}]`;
    }
}

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
            radius_meters: radius_meters || 100,
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

// ✅ Safe Zone Violation Check with ENHANCED LOGGING + 50M RETURN BUFFER + BETTER MESSAGES
exports.checkSafeZoneViolation = async (vehicleId, currentLat, currentLon) => {
    console.log(`\n========================================`);
    console.log(`🚨 SAFE ZONE CHECK STARTED`);
    console.log(`========================================`);
    console.log(`🚗 Vehicle ID: ${vehicleId}`);
    console.log(`📍 Current Position: [${currentLat}, ${currentLon}]`);

    try {
        // ✅ STEP 1: Fetch safe zone
        console.log(`\n🔍 STEP 1: Fetching safe zone from database...`);
        const safeZone = await SafeZone.findOne({
            where: {
                vehicle_id: vehicleId,
                is_active: true
            },
            include: [{
                model: Voiture,
                as: 'vehicle',
                attributes: ['id', 'model', 'immatriculation', 'nickname']
            }]
        });

        if (!safeZone) {
            console.log("ℹ️ No active safe zone configured for this vehicle");
            console.log(`========================================\n`);
            return { violation: false, safeZone: null };
        }

        console.log(`✅ Safe zone found!`);
        console.log(`   ID: ${safeZone.id}`);
        console.log(`   Name: ${safeZone.name}`);
        console.log(`   Center: [${safeZone.center_latitude}, ${safeZone.center_longitude}]`);
        console.log(`   Radius: ${safeZone.radius_meters}m`);
        console.log(`   Alert Triggered: ${safeZone.alert_triggered ? 'TRUE' : 'FALSE'}`);
        console.log(`   User ID: ${safeZone.user_id}`);

        // ✅ STEP 2: Calculate distance
        console.log(`\n🔍 STEP 2: Calculating distance...`);
        const distance = calculateDistance(
            safeZone.center_latitude,
            safeZone.center_longitude,
            currentLat,
            currentLon
        );

        console.log(`📏 Distance from center: ${distance.toFixed(2)}m`);
        console.log(`📏 Allowed radius: ${safeZone.radius_meters}m`);

        // ✅ HYSTERESIS: Use different thresholds for leaving vs returning
        const RETURN_BUFFER = 50; // 50m buffer for return
        const isOutside = distance > safeZone.radius_meters;
        const isInside = distance < (safeZone.radius_meters - RETURN_BUFFER);

        console.log(`🎯 Vehicle is: ${isOutside ? '🔴 OUTSIDE' : (isInside ? '🟢 INSIDE' : '⚪ IN BUFFER ZONE')} safe zone`);
        console.log(`   Return threshold: ${safeZone.radius_meters - RETURN_BUFFER}m`);

        // ✅ STEP 3: Check if alert should be triggered
        console.log(`\n🔍 STEP 3: Checking alert conditions...`);
        console.log(`   Is Outside: ${isOutside}`);
        console.log(`   Is Inside (with buffer): ${isInside}`);
        console.log(`   Alert Already Triggered: ${safeZone.alert_triggered}`);
        console.log(`   Should Create Leave Alert: ${isOutside && !safeZone.alert_triggered}`);
        console.log(`   Should Create Return Alert: ${isInside && safeZone.alert_triggered}`);

        // ✅ Vehicle LEFT safe zone - send alert
        if (isOutside && !safeZone.alert_triggered) {
            console.log(`\n========================================`);
            console.log(`🚨 SAFE ZONE VIOLATION DETECTED!`);
            console.log(`========================================`);
            console.log(`Vehicle ${vehicleId} has LEFT the safe zone!`);
            console.log(`Distance: ${Math.round(distance)}m (limit: ${safeZone.radius_meters}m)`);

            // ✅ STEP 4: Update safe zone flag
            console.log(`\n🔍 STEP 4: Updating safe zone flag...`);
            safeZone.alert_triggered = true;
            safeZone.last_alert_at = new Date();
            await safeZone.save();
            console.log(`✅ Safe zone alert_triggered set to TRUE`);
            console.log(`✅ last_alert_at set to: ${safeZone.last_alert_at}`);

            // ✅ Get location name
            console.log(`\n🔍 STEP 4.5: Getting location name...`);
            const locationName = await getLocationName(currentLat, currentLon);
            console.log(`📍 Location: ${locationName}`);

            const vehicleNickname = safeZone.vehicle?.nickname || safeZone.vehicle?.model || 'Your vehicle';

            // ✅ NEW MESSAGE FORMAT: "Your vehicle NICKNAME left the safe zone just now from LOCATION"
            const alertMessage = `⚠️ ${vehicleNickname} left the safe zone just now from ${locationName}`;

            // ✅ STEP 5: Create alert in database
            console.log(`\n🔍 STEP 5: Creating alert in database...`);
            console.log(`   Message: ${alertMessage}`);

            try {
                const newAlert = await Alert.create({
                    voiture_id: vehicleId,
                    alert_type: 'safe_zone',
                    message: alertMessage,
                    latitude: currentLat,
                    longitude: currentLon,
                    alerted_at: new Date(),
                    sent: true,
                    read: false
                });
                console.log(`✅ ALERT CREATED IN DATABASE!`);
                console.log(`   Alert ID: ${newAlert.id}`);
                console.log(`   Vehicle ID: ${newAlert.voiture_id}`);
                console.log(`   Type: ${newAlert.alert_type}`);
                console.log(`   Message: ${newAlert.message}`);
                console.log(`   Location: [${newAlert.latitude}, ${newAlert.longitude}]`);
                console.log(`   Created At: ${newAlert.alerted_at}`);

                // ✅ STEP 6: Send push notification
                console.log(`\n🔍 STEP 6: Sending push notification...`);
                console.log(`   User ID: ${safeZone.user_id}`);
                console.log(`   Vehicle Nickname: ${vehicleNickname}`);
                console.log(`   Zone Name: ${safeZone.name}`);

                try {
                    const notificationResult = await NotificationService.sendSafeZoneAlert(
                        safeZone.user_id,
                        vehicleNickname,
                        safeZone.name,
                        'left'
                    );

                    if (notificationResult.success) {
                        console.log(`✅ PUSH NOTIFICATION SENT SUCCESSFULLY!`);
                        console.log(`   Success Count: ${notificationResult.successCount}`);
                        console.log(`   Failure Count: ${notificationResult.failureCount}`);
                    } else {
                        console.log(`⚠️ Push notification failed: ${notificationResult.message}`);
                    }
                } catch (notifError) {
                    console.error(`❌ PUSH NOTIFICATION ERROR:`, notifError.message);
                    console.error(`Stack trace:`, notifError.stack);
                }

                // ✅ STEP 7: Emit Socket.IO notification
                console.log(`\n🔍 STEP 7: Emitting Socket.IO notification...`);
                try {
                    socketService.emitToVehicle(vehicleId, 'safe_zone_alert', {
                        alertId: newAlert.id,
                        type: 'safe_zone_violation',
                        severity: 'warning',
                        title: 'Safe Zone Alert',
                        message: alertMessage,
                        vehicleId: vehicleId,
                        vehicleName: vehicleNickname,
                        safeZoneName: safeZone.name,
                        distance: Math.round(distance),
                        location: locationName,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`✅ Socket.IO notification emitted`);
                } catch (socketError) {
                    console.error(`❌ Socket.IO error:`, socketError.message);
                }

                console.log(`\n========================================`);
                console.log(`✅ SAFE ZONE VIOLATION ALERT COMPLETE`);
                console.log(`========================================\n`);

                return {
                    violation: true,
                    safeZone,
                    distance: Math.round(distance),
                    isFirstAlert: true,
                    alertId: newAlert.id
                };

            } catch (alertError) {
                console.error(`\n========================================`);
                console.error(`❌ ERROR CREATING ALERT IN DATABASE`);
                console.error(`========================================`);
                console.error(`Error message:`, alertError.message);
                console.error(`Stack trace:`, alertError.stack);
                console.error(`========================================\n`);
                throw alertError;
            }
        }

        // ✅ Vehicle RETURNED to safe zone (with 50m buffer)
        if (isInside && safeZone.alert_triggered) {
            console.log(`\n========================================`);
            console.log(`✅ VEHICLE RETURNED TO SAFE ZONE`);
            console.log(`========================================`);
            console.log(`Distance: ${Math.round(distance)}m (return threshold: ${safeZone.radius_meters - RETURN_BUFFER}m)`);

            safeZone.alert_triggered = false;
            await safeZone.save();
            console.log(`✅ Safe zone alert_triggered reset to FALSE`);

            // ✅ Get location name
            console.log(`\n🔍 Getting return location name...`);
            const locationName = await getLocationName(currentLat, currentLon);
            console.log(`📍 Location: ${locationName}`);

            const vehicleNickname = safeZone.vehicle?.nickname || safeZone.vehicle?.model || 'Your vehicle';

            // ✅ NEW MESSAGE FORMAT: "Your vehicle NICKNAME returned to safe zone just now at LOCATION"
            const returnMessage = `✅ ${vehicleNickname} returned to safe zone just now at ${locationName}`;

            const returnAlert = await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'safe_zone',
                message: returnMessage,
                latitude: currentLat,
                longitude: currentLon,
                alerted_at: new Date(),
                sent: true,
                read: false
            });
            console.log(`✅ Return alert created: ID=${returnAlert.id}`);

            // ✅ Use the same notification method
            try {
                const notificationResult = await NotificationService.sendSafeZoneAlert(
                    safeZone.user_id,
                    vehicleNickname,
                    safeZone.name,
                    'returned'
                );

                if (notificationResult.success) {
                    console.log(`✅ RETURN PUSH NOTIFICATION SENT SUCCESSFULLY!`);
                    console.log(`   Success Count: ${notificationResult.successCount}`);
                    console.log(`   Failure Count: ${notificationResult.failureCount}`);
                } else {
                    console.log(`⚠️ Return push notification failed: ${notificationResult.message}`);
                }
            } catch (notifError) {
                console.error(`❌ RETURN PUSH NOTIFICATION ERROR:`, notifError.message);
                console.error(`Stack trace:`, notifError.stack);
            }

            try {
                socketService.emitToVehicle(vehicleId, 'safe_zone_alert', {
                    alertId: returnAlert.id,
                    type: 'safe_zone_return',
                    severity: 'info',
                    title: 'Safe Zone Return',
                    message: returnMessage,
                    vehicleId: vehicleId,
                    vehicleName: vehicleNickname,
                    safeZoneName: safeZone.name,
                    location: locationName,
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Return Socket.IO notification emitted`);
            } catch (socketError) {
                console.error(`⚠️ Socket.IO emit failed:`, socketError.message);
            }

            console.log(`========================================\n`);

            return {
                violation: false,
                safeZone,
                distance: Math.round(distance),
                isFirstAlert: true,
                alertId: returnAlert.id,
                returned: true
            };
        }

        // ✅ No status change
        if (isOutside && safeZone.alert_triggered) {
            console.log(`ℹ️ Vehicle still outside safe zone (alert already sent)`);
        } else if (!isOutside && !isInside && safeZone.alert_triggered) {
            console.log(`ℹ️ Vehicle in buffer zone (${RETURN_BUFFER}m) - waiting for clear return`);
        } else if (isInside && !safeZone.alert_triggered) {
            console.log(`ℹ️ Vehicle inside safe zone (no alert needed)`);
        }

        console.log(`========================================\n`);

        return {
            violation: isOutside,
            safeZone,
            distance: Math.round(distance),
            isFirstAlert: false
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