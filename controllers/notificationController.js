// controllers/notificationController.js
const admin       = require('firebase-admin');
const DeviceToken = require('../models/DeviceToken');
const logger      = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Firebase Admin SDK — initialised once at module load
// ─────────────────────────────────────────────────────────────────────────────
if (!admin.apps.length) {
    try {
        const serviceAccount = require('../config/firebase-service-account.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        logger.info('Firebase Admin initialized');
    } catch (error) {
        logger.error('Firebase Admin initialization failed:', error);
        logger.warn('Push notifications will not work without Firebase Admin SDK');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER / UNREGISTER DEVICE TOKEN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/notifications/register-token
 */
exports.registerToken = async (req, res) => {
    try {
        const { token, device_type, device_id } = req.body;
        const userId = req.user.id;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required' });
        }

        logger.info(`[NOTIFICATION] Registering FCM token for user ${userId}`);

        let deviceToken = await DeviceToken.findOne({ where: { token } });

        if (deviceToken) {
            await deviceToken.update({
                user_id:      userId,
                device_type:  device_type || 'android',
                device_id:    device_id   || null,
                is_active:    true,
                last_used_at: new Date(),
            });
            logger.info(`[NOTIFICATION] Updated device token for user ${userId}`);
        } else {
            deviceToken = await DeviceToken.create({
                user_id:      userId,
                token,
                device_type:  device_type || 'android',
                device_id,
                is_active:    true,
                last_used_at: new Date(),
            });
            logger.info(`[NOTIFICATION] Registered new device token for user ${userId}`);
        }

        return res.status(201).json({
            success: true,
            message: 'Device token registered successfully',
            data: { id: deviceToken.id, device_type: deviceToken.device_type },
        });
    } catch (error) {
        logger.error('[NOTIFICATION] Error registering device token:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to register device token',
            error:   error.message,
        });
    }
};

/**
 * POST /api/notifications/unregister-token
 */
exports.unregisterToken = async (req, res) => {
    try {
        const { token } = req.body;
        const userId    = req.user.id;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required' });
        }

        await DeviceToken.update(
            { is_active: false },
            { where: { user_id: userId, token } },
        );

        logger.info(`[NOTIFICATION] Unregistered device token for user ${userId}`);

        return res.status(200).json({ success: true, message: 'Device token unregistered successfully' });
    } catch (error) {
        logger.error('[NOTIFICATION] Error unregistering device token:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to unregister device token',
            error:   error.message,
        });
    }
};

/**
 * GET /api/notifications/devices
 */
exports.getDevices = async (req, res) => {
    try {
        const userId = req.user.id;

        const devices = await DeviceToken.findAll({
            where:      { user_id: userId },
            attributes: ['id', 'device_type', 'device_id', 'is_active', 'last_used_at', 'created_at'],
            order:      [['last_used_at', 'DESC']],
        });

        return res.status(200).json({ success: true, count: devices.length, data: devices });
    } catch (error) {
        logger.error('[NOTIFICATION] Error fetching devices:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch devices',
            error:   error.message,
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CORE SEND HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a push notification to all active devices of a user.
 *
 * @param {number} userId
 * @param {{ title: string, body: string, data?: Record<string, string> }} notification
 * @returns {Promise<{ success: boolean, successCount?: number, failureCount?: number }>}
 */
exports.sendToUser = async (userId, notification) => {
    try {
        logger.info(`[NOTIFICATION] Sending to user ${userId}`);

        const deviceTokens = await DeviceToken.findAll({
            where: { user_id: userId, is_active: true },
        });

        if (deviceTokens.length === 0) {
            logger.warn(`[NOTIFICATION] No active FCM tokens for user ${userId}`);
            return { success: false, message: 'No tokens found' };
        }

        const tokens = deviceTokens.map(dt => dt.token);
        logger.info(`[NOTIFICATION] Sending to ${tokens.length} device(s)`);

        // All FCM data values must be strings
        const dataPayload = {};
        if (notification.data) {
            Object.keys(notification.data).forEach((key) => {
                dataPayload[key] = String(notification.data[key]);
            });
        }

        let successCount = 0;
        let failureCount = 0;
        const tokensToRemove = [];

        for (const token of tokens) {
            try {
                const message = {
                    token,
                    notification: {
                        title: notification.title,
                        body: notification.body,
                    },
                    data: dataPayload,

                    android: {
                        priority: 'high',
                        notification: {
                            sound: 'default',
                            click_action: 'FLUTTER_NOTIFICATION_CLICK',
                            channel_id: 'default_channel',
                        },
                    },

                    apns: {
                        headers: {
                            'apns-priority': '10',
                            'apns-push-type': 'alert',
                        },
                        payload: {
                            aps: {
                                alert: {
                                    title: notification.title,
                                    body: notification.body,
                                },
                                sound: 'default',
                                badge: 1,
                                'content-available': 1,
                            },
                        },
                    },
                };

                const response = await admin.messaging().send(message);
                successCount++;

                logger.info(
                    `[NOTIFICATION] Sent successfully to token (user ${userId}) messageId=${response}`
                );
            } catch (error) {
                failureCount++;
                logger.error(`[NOTIFICATION] Failed to send to token: ${error.message}`);

                if (
                    error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered'
                ) {
                    tokensToRemove.push(token);
                }
            }
        }

        logger.info(
            `[NOTIFICATION] Result: ${successCount} success, ${failureCount} failure(s)`
        );

        if (tokensToRemove.length > 0) {
            await DeviceToken.destroy({
                where: { token: tokensToRemove }
            });
            logger.info(`[NOTIFICATION] Removed ${tokensToRemove.length} stale token(s)`);
        }

        return {
            success: true,
            successCount,
            failureCount
        };
    } catch (error) {
        logger.error('[NOTIFICATION] sendToUser error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN-SPECIFIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payment result notification — called by paygateWebhook after SUCCESS or FAILED.
 */
exports.sendPaymentNotification = async (userId, status, planLabel, paymentId, vehicleId) => {
    logger.info(`[NOTIFICATION] Payment notification → user ${userId} | status: ${status}`);

    if (status === 'SUCCESS') {
        return exports.sendToUser(userId, {
            title: '✅ Payment Successful',
            body:  `Your subscription for "${planLabel}" is now active.`,
            data: {
                type:       'payment_success',
                payment_id: String(paymentId),
                vehicle_id: String(vehicleId),
                plan_label: planLabel,
            },
        });
    }

    if (status === 'FAILED') {
        return exports.sendToUser(userId, {
            title: '❌ Payment Failed',
            body:  'Your payment could not be processed. Please try again.',
            data: {
                type:       'payment_failed',
                payment_id: String(paymentId),
                vehicle_id: String(vehicleId),
            },
        });
    }

    logger.warn(`[NOTIFICATION] sendPaymentNotification: unknown status "${status}"`);
    return { success: false, message: `Unknown status: ${status}` };
};

/**
 * Subscription expiry reminder — called by subscriptionExpiryService.
 *
 * @param {number}   userId
 * @param {number}   daysLeft    — 1, 2, or 3
 * @param {string[]} plates      — array of immatriculation strings
 * @param {string}   vehicleIds  — comma-separated vehicle id string
 */
exports.sendSubscriptionExpiryNotification = async (userId, daysLeft, plates, vehicleIds) => {
    logger.info(`[NOTIFICATION] Expiry reminder → user ${userId} | daysLeft: ${daysLeft}`);

    const plateList  = plates.join(', ');
    const title      = daysLeft === 1
        ? '⚠️ Subscription expires tomorrow!'
        : `🔔 Subscription expires in ${daysLeft} days`;
    const body       = plates.length === 1
        ? `Vehicle ${plateList} — renew now to keep tracking.`
        : `Vehicles ${plateList} — renew now to keep tracking.`;

    return exports.sendToUser(userId, {
        title,
        body,
        data: {
            type:        'subscription_expiry',
            days_left:   String(daysLeft),
            vehicle_ids: vehicleIds,
            plates:      plateList,
        },
    });
};

/**
 * Safe zone alert — vehicle left or returned to zone.
 */
exports.sendSafeZoneAlert = async (userId, vehicleName, zoneName, action = 'left') => {
    logger.info(`[NOTIFICATION] Safe zone alert → user ${userId} | action: ${action}`);

    const isReturn = action === 'returned';

    return exports.sendToUser(userId, {
        title: isReturn ? '✅ Safe Zone Alert' : '🚨 Safe Zone Alert',
        body:  isReturn
            ? `${vehicleName} returned to safe zone "${zoneName}"`
            : `${vehicleName} left safe zone "${zoneName}"`,
        data: {
            type:      'safe_zone',
            action,
            vehicle:   vehicleName,
            zone:      zoneName,
            timestamp: new Date().toISOString(),
        },
    });
};

/**
 * Geofence alert.
 */
exports.sendGeofenceAlert = async (userId, vehicleName, action, zoneName) => {
    logger.info(`[NOTIFICATION] Geofence alert → user ${userId}`);

    return exports.sendToUser(userId, {
        title: '📍 Geofence Alert',
        body:  `${vehicleName} ${action} geofence "${zoneName}"`,
        data: {
            type:      'geofence',
            vehicle:   vehicleName,
            action,
            zone:      zoneName,
            timestamp: new Date().toISOString(),
        },
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/notifications/test
 */
exports.sendTestNotification = async (req, res) => {
    try {
        const userId      = req.user.id;
        const { title, body } = req.body;

        const result = await exports.sendToUser(userId, {
            title: title || '🔔 Test Notification',
            body:  body  || 'This is a test notification from PROXYM TRACKING!',
            data: {
                type:      'test',
                timestamp: new Date().toISOString(),
            },
        });

        return res.status(200).json({ success: true, message: 'Test notification sent', data: result });
    } catch (error) {
        logger.error('[NOTIFICATION] Error sending test notification:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to send test notification',
            error:   error.message,
        });
    }
};

module.exports = exports;