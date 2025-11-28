// backend/controllers/notificationController.js
const admin = require('firebase-admin');
const DeviceToken = require('../models/DeviceToken');

// ✅ Initialize Firebase Admin SDK (only once)
if (!admin.apps.length) {
    try {
        const serviceAccount = require('../config/firebase-service-account.json');

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('✅ Firebase Admin initialized');
    } catch (error) {
        console.error('❌ Firebase Admin initialization failed:', error);
        console.error('⚠️ Push notifications will not work without Firebase Admin SDK');
    }
}

/**
 * ✅ Register or update a device token
 */
exports.registerToken = async (req, res) => {
    try {
        const { token, device_type, device_id } = req.body;
        const userId = req.user.id;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Token is required'
            });
        }

        console.log(`📱 Registering FCM token for user ${userId}`);

        let deviceToken = await DeviceToken.findOne({
            where: { token }
        });

        if (deviceToken) {
            await deviceToken.update({
                user_id: userId,
                device_type: device_type || 'android',
                device_id: device_id || null,
                is_active: true,
                last_used_at: new Date()
            });

            console.log(`✅ Updated device token for user ${userId}`);
        } else {
            deviceToken = await DeviceToken.create({
                user_id: userId,
                token,
                device_type: device_type || 'android',
                device_id,
                is_active: true,
                last_used_at: new Date()
            });

            console.log(`✅ Registered new device token for user ${userId}`);
        }

        return res.status(201).json({
            success: true,
            message: 'Device token registered successfully',
            data: {
                id: deviceToken.id,
                device_type: deviceToken.device_type
            }
        });
    } catch (error) {
        console.error('❌ Error registering device token:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to register device token',
            error: error.message
        });
    }
};

/**
 * ✅ Send push notification to specific user (FIXED for older Firebase SDK)
 */
exports.sendToUser = async (userId, notification) => {
    try {
        console.log(`📤 Sending notification to user ${userId}`);

        const deviceTokens = await DeviceToken.findAll({
            where: {
                user_id: userId,
                is_active: true
            }
        });

        if (deviceTokens.length === 0) {
            console.log('⚠️ No FCM tokens found for user');
            return { success: false, message: 'No tokens found' };
        }

        const tokens = deviceTokens.map(dt => dt.token);
        console.log(`📱 Sending to ${tokens.length} device(s)`);

        // Prepare data - all values must be strings for FCM
        const dataPayload = {};
        if (notification.data) {
            Object.keys(notification.data).forEach(key => {
                dataPayload[key] = String(notification.data[key]);
            });
        }

        // ✅ FIXED: Use sendEachForMulticast or send() for older SDK versions
        let successCount = 0;
        let failureCount = 0;
        const tokensToRemove = [];

        // Send to each token individually (works with all Firebase SDK versions)
        for (const token of tokens) {
            try {
                const message = {
                    notification: {
                        title: notification.title,
                        body: notification.body,
                    },
                    data: dataPayload,
                    token: token // Send to single token
                };

                await admin.messaging().send(message);
                successCount++;
                console.log(`✅ Notification sent to token: ${token.substring(0, 20)}...`);
            } catch (error) {
                failureCount++;
                console.error(`❌ Failed to send to token: ${error.message}`);

                // Remove invalid tokens
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    tokensToRemove.push(token);
                }
            }
        }

        console.log(`✅ Notification sent: ${successCount} success, ${failureCount} failures`);

        // Remove invalid tokens
        if (tokensToRemove.length > 0) {
            await DeviceToken.destroy({
                where: { token: tokensToRemove }
            });
            console.log(`🗑️ Removed ${tokensToRemove.length} invalid tokens`);
        }

        return {
            success: true,
            successCount: successCount,
            failureCount: failureCount
        };
    } catch (error) {
        console.error('❌ Send notification error:', error);
        return { success: false, error: error.message };
    }
};

/**
 * ✅ Send safe zone alert
 */
exports.sendSafeZoneAlert = async (userId, vehicleName, zoneName) => {
    console.log(`🛡️ Sending safe zone alert to user ${userId}`);
    return await exports.sendToUser(userId, {
        title: '🛡️ Safe Zone Alert',
        body: `${vehicleName} left safe zone "${zoneName}"`,
        data: {
            type: 'safe_zone',
            vehicle: vehicleName,
            zone: zoneName,
            timestamp: new Date().toISOString()
        }
    });
};

/**
 * ✅ Send geofence alert
 */
exports.sendGeofenceAlert = async (userId, vehicleName, action, zoneName) => {
    console.log(`📍 Sending geofence alert to user ${userId}`);
    return await exports.sendToUser(userId, {
        title: '📍 Geofence Alert',
        body: `${vehicleName} ${action} geofence "${zoneName}"`,
        data: {
            type: 'geofence',
            vehicle: vehicleName,
            action: action,
            zone: zoneName,
            timestamp: new Date().toISOString()
        }
    });
};

/**
 * ✅ Unregister a device token (on logout)
 */
exports.unregisterToken = async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user.id;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Token is required'
            });
        }

        await DeviceToken.update(
            { is_active: false },
            {
                where: {
                    user_id: userId,
                    token
                }
            }
        );

        console.log(`✅ Unregistered device token for user ${userId}`);

        return res.status(200).json({
            success: true,
            message: 'Device token unregistered successfully'
        });
    } catch (error) {
        console.error('❌ Error unregistering device token:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to unregister device token',
            error: error.message
        });
    }
};

/**
 * ✅ Get all registered devices for current user
 */
exports.getDevices = async (req, res) => {
    try {
        const userId = req.user.id;

        const devices = await DeviceToken.findAll({
            where: { user_id: userId },
            attributes: ['id', 'device_type', 'device_id', 'is_active', 'last_used_at', 'created_at'],
            order: [['last_used_at', 'DESC']]
        });

        return res.status(200).json({
            success: true,
            count: devices.length,
            data: devices
        });
    } catch (error) {
        console.error('❌ Error fetching devices:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch devices',
            error: error.message
        });
    }
};

/**
 * ✅ Send test notification (for testing purposes)
 */
exports.sendTestNotification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { title, body } = req.body;

        const result = await exports.sendToUser(userId, {
            title: title || '🔔 Test Notification',
            body: body || 'This is a test notification from PROXYM TRACKING!',
            data: {
                type: 'test',
                timestamp: new Date().toISOString()
            }
        });

        return res.status(200).json({
            success: true,
            message: 'Test notification sent',
            data: result
        });
    } catch (error) {
        console.error('❌ Error sending test notification:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to send test notification',
            error: error.message
        });
    }
};

module.exports = exports;