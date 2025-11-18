// backend/services/notificationService.js
const admin = require('firebase-admin');
const path = require('path');
const DeviceToken = require('../models/DeviceToken');

// Initialize Firebase Admin
const serviceAccount = require('../config/firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

class NotificationService {
    /**
     * Send notification to a specific user
     */
    static async sendToUser(userId, notification) {
        try {
            // Get all active device tokens for this user
            const tokens = await DeviceToken.findAll({
                where: {
                    user_id: userId,
                    is_active: true
                }
            });

            if (tokens.length === 0) {
                console.log(`📱 No active tokens found for user ${userId}`);
                return { success: false, message: 'No active devices' };
            }

            const fcmTokens = tokens.map(t => t.token);

            const message = {
                notification: {
                    title: notification.title,
                    body: notification.body,
                },
                data: notification.data || {},
                tokens: fcmTokens
            };

            // Send to multiple devices
            const response = await admin.messaging().sendEachForMulticast(message);

            console.log(`✅ Sent notification to ${response.successCount}/${fcmTokens.length} devices`);

            // Handle failed tokens (remove invalid ones)
            if (response.failureCount > 0) {
                const failedTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        failedTokens.push(fcmTokens[idx]);
                    }
                });

                // Deactivate failed tokens
                await DeviceToken.update(
                    { is_active: false },
                    { where: { token: failedTokens } }
                );

                console.log(`⚠️ Deactivated ${failedTokens.length} invalid tokens`);
            }

            return {
                success: true,
                successCount: response.successCount,
                failureCount: response.failureCount
            };
        } catch (error) {
            console.error('❌ Error sending notification:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Send GEOFENCE alert
     */
    static async sendGeofenceAlert(userId, vehicleModel, zoneName, eventType) {
        const titles = {
            enter: '🚗 Vehicle Entered Zone',
            exit: '🚗 Vehicle Exited Zone'
        };

        const bodies = {
            enter: `${vehicleModel} has entered ${zoneName}`,
            exit: `${vehicleModel} has exited ${zoneName}`
        };

        return await this.sendToUser(userId, {
            title: titles[eventType] || 'Geofence Alert',
            body: bodies[eventType] || `${vehicleModel} - ${zoneName}`,
            data: {
                type: 'geofence',
                event: eventType,
                zone_name: zoneName,
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send SAFE ZONE alert (when vehicle leaves safe zone)
     */
    static async sendSafeZoneAlert(userId, vehicleModel, zoneName) {
        return await this.sendToUser(userId, {
            title: '⚠️ Safe Zone Alert',
            body: `${vehicleModel} has left safe zone: ${zoneName}`,
            data: {
                type: 'safe_zone',
                event: 'exit',
                zone_name: zoneName,
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send SPEEDING alert
     */
    static async sendSpeedingAlert(userId, vehicleModel, currentSpeed, speedLimit) {
        return await this.sendToUser(userId, {
            title: '⚡ Speeding Alert',
            body: `${vehicleModel} is speeding! ${currentSpeed} km/h (limit: ${speedLimit} km/h)`,
            data: {
                type: 'speeding',
                current_speed: currentSpeed.toString(),
                speed_limit: speedLimit.toString(),
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send ENGINE CUT alert
     */
    static async sendEngineCutAlert(userId, vehicleModel) {
        return await this.sendToUser(userId, {
            title: '🔴 Engine Cut Off',
            body: `${vehicleModel}'s engine has been remotely cut off`,
            data: {
                type: 'engine_control',
                event: 'cut_off',
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send ENGINE RESUME alert
     */
    static async sendEngineResumeAlert(userId, vehicleModel) {
        return await this.sendToUser(userId, {
            title: '🟢 Engine Resumed',
            body: `${vehicleModel}'s engine has been restored`,
            data: {
                type: 'engine_control',
                event: 'resume',
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send LOW BATTERY alert
     */
    static async sendLowBatteryAlert(userId, vehicleModel, batteryLevel) {
        return await this.sendToUser(userId, {
            title: '🔋 Low Battery Warning',
            body: `${vehicleModel}'s battery is low (${batteryLevel}%)`,
            data: {
                type: 'battery',
                battery_level: batteryLevel.toString(),
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send TRIP START alert
     */
    static async sendTripStartAlert(userId, vehicleModel, startAddress) {
        return await this.sendToUser(userId, {
            title: '🚀 Trip Started',
            body: `${vehicleModel} started a trip from ${startAddress}`,
            data: {
                type: 'trip',
                event: 'start',
                address: startAddress,
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Send TRIP END alert
     */
    static async sendTripEndAlert(userId, vehicleModel, endAddress, duration, distance) {
        return await this.sendToUser(userId, {
            title: '🏁 Trip Ended',
            body: `${vehicleModel} trip ended at ${endAddress}. Duration: ${duration}, Distance: ${distance} km`,
            data: {
                type: 'trip',
                event: 'end',
                address: endAddress,
                duration: duration,
                distance: distance.toString(),
                timestamp: new Date().toISOString()
            }
        });
    }
}

module.exports = NotificationService;