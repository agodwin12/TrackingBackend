// services/deviceAlertService.js
const Voiture = require('../models/voiture');
const Alert = require('../models/alert');
const User = require('../models/userModel');
const firebaseService = require('./notificationService');
const sequelize = require('../config/database');

class DeviceAlertService {
    constructor() {
        // Alarm type codes from GPS API - ONLY DISCONNECTION/REMOVAL ALARMS
        this.ALARM_TYPES = {
            OFFLINE: 37,              // 0x25 - Device offline
            REMOVAL: 38,              // 0x26 - Device removal/disassembly
            DISCONNECTION: 31,        // 🆕 0x1F - Disconnection alarm (PRIMARY)
            DEVICE_UNPLUGGED: 91,     // 🆕 0x5B - Device unplugged
            CONNECTION_LOSS: 67       // 🆕 0x43 - Loss of connection
        };

        // Configuration for each alarm type
        this.ALARM_CONFIG = {
            [0x25]: {
                type: 'offline',
                title: 'Device Offline Alert',
                getMessage: (vehicleName) => `Vehicle ${vehicleName} GPS device is offline. No communication with server.`,
                cooldownMinutes: 60,
                emoji: '📡',
                severity: 'critical'
            },
            [0x26]: {
                type: 'device_removal',
                title: 'Device Removal Alert',
                getMessage: (vehicleName) => `⚠️ CRITICAL: GPS device removal detected on vehicle ${vehicleName}!`,
                cooldownMinutes: 15,
                emoji: '🚨',
                severity: 'critical'
            },

            // 🆕 NEW: Disconnection alarms
            [0x1F]: {
                type: 'disconnection',
                title: 'GPS Disconnection Alert',
                getMessage: (vehicleName) => `⚠️ GPS device disconnected from vehicle ${vehicleName}. Connection lost.`,
                cooldownMinutes: 30,
                emoji: '🔌',
                severity: 'critical'
            },
            [0x5B]: {
                type: 'device_unplugged',
                title: 'Device Unplugged Alert',
                getMessage: (vehicleName) => `⚠️ CRITICAL: GPS device physically unplugged from vehicle ${vehicleName}!`,
                cooldownMinutes: 15,
                emoji: '🔌❌',
                severity: 'critical'
            },
            [0x43]: {
                type: 'connection_loss',
                title: 'Connection Loss Alert',
                getMessage: (vehicleName) => `📡 Communication lost with GPS device on vehicle ${vehicleName}.`,
                cooldownMinutes: 45,
                emoji: '📡❌',
                severity: 'high'
            }
        };
    }

    /**
     * Process any device alarm from GPS API
     * @param {Object} alarmData - Alarm data from GPS API with type_id
     */
    async processAlarm(alarmData) {
        try {
            // Parse type_id (could be decimal or hex string)
            const typeId = parseInt(alarmData.type_id);

            // Check if this is a supported alarm type
            const alarmConfig = this.ALARM_CONFIG[typeId];

            if (!alarmConfig) {
                console.log(`ℹ️ Alarm type ${typeId} (0x${typeId.toString(16)}) is not configured, skipping`);
                return;
            }

            console.log(`\n${alarmConfig.emoji} ========== ${alarmConfig.type.toUpperCase()} ALARM CHECK STARTED ==========`);
            console.log(`📊 Alarm Data:`, JSON.stringify(alarmData, null, 2));
            console.log(`🔍 Type ID: 0x${typeId.toString(16).toUpperCase()} (${typeId} decimal)`);
            console.log(`⚠️ ${alarmConfig.type.toUpperCase()} ALARM DETECTED!`);

            // Get vehicle information
            const macId = alarmData.macid || alarmData.mac_id;
            if (!macId) {
                console.log('❌ No MAC ID found in alarm data');
                console.log(`${alarmConfig.emoji} ========== ALARM CHECK ENDED ==========\n`);
                return;
            }

            console.log(`🔍 Looking up vehicle with MAC ID: ${macId}`);

            // Find vehicle by MAC ID
            const vehicle = await Voiture.findOne({
                where: { mac_id_gps: macId }
            });

            if (!vehicle) {
                console.log(`❌ Vehicle not found with MAC ID: ${macId}`);
                console.log(`${alarmConfig.emoji} ========== ALARM CHECK ENDED ==========\n`);
                return;
            }

            const vehicleName = vehicle.nickname || vehicle.model || `GPS-${macId}`;
            console.log(`✅ Vehicle found: ${vehicleName} (ID: ${vehicle.id})`);

            // Find the user associated with this vehicle
            console.log('🔍 Fetching user from association table...');
            const [user] = await sequelize.query(`
                SELECT u.*
                FROM users u
                         INNER JOIN association_user_voitures auv ON u.id = auv.user_id
                WHERE auv.voiture_id = ?
                    LIMIT 1
            `, {
                replacements: [vehicle.id],
                type: sequelize.QueryTypes.SELECT
            });

            if (!user) {
                console.log(`❌ No user found for vehicle ${vehicle.id}`);
                console.log(`${alarmConfig.emoji} ========== ALARM CHECK ENDED ==========\n`);
                return;
            }

            console.log(`✅ User found: ${user.nom} ${user.prenom} (ID: ${user.id})`);
            console.log(`📱 User FCM Token: ${user.fcm_token ? 'Present' : 'Missing'}`);

            // Check cooldown - don't spam alerts
            console.log('⏱️ Checking alert cooldown...');
            const lastAlert = await this.getLastAlert(vehicle.id, alarmConfig.type);

            if (lastAlert) {
                const minutesSinceLastAlert = (Date.now() - new Date(lastAlert.alerted_at).getTime()) / (1000 * 60);
                console.log(`📅 Last alert was ${Math.round(minutesSinceLastAlert)} minutes ago`);
                console.log(`⏰ Cooldown period: ${alarmConfig.cooldownMinutes} minutes`);

                if (minutesSinceLastAlert < alarmConfig.cooldownMinutes) {
                    console.log(`⏳ ${alarmConfig.type} alert cooldown active for vehicle ${vehicleName}`);
                    console.log(`⏳ Time remaining: ${Math.round(alarmConfig.cooldownMinutes - minutesSinceLastAlert)} minutes`);
                    console.log(`${alarmConfig.emoji} ========== ALARM CHECK ENDED ==========\n`);
                    return;
                }
                console.log('✅ Cooldown period expired, proceeding with alert');
            } else {
                console.log('✅ No previous alert found, proceeding with alert');
            }

            // Create alert
            console.log(`🚨 Creating ${alarmConfig.type} alert...`);
            await this.createAlert(vehicle, user, alarmData, alarmConfig);

            console.log(`${alarmConfig.emoji} ${alarmConfig.type} alert created for vehicle ${vehicleName}`);
            console.log(`${alarmConfig.emoji} ========== ALARM CHECK ENDED ==========\n`);

        } catch (error) {
            console.error('🔥 Error processing alarm:', error);
            console.error('🔥 Stack trace:', error.stack);
            console.log('========== ALARM CHECK ENDED (ERROR) ==========\n');
        }
    }

    /**
     * Get the last alert of a specific type for a vehicle
     */
    async getLastAlert(vehicleId, alertType) {
        try {
            console.log(`🔍 Querying last ${alertType} alert for vehicle ${vehicleId}...`);
            const alert = await Alert.findOne({
                where: {
                    voiture_id: vehicleId,
                    alert_type: alertType
                },
                order: [['alerted_at', 'DESC']]
            });

            if (alert) {
                console.log(`✅ Found last alert: ID ${alert.id}, created at ${alert.alerted_at}`);
            } else {
                console.log(`ℹ️ No previous ${alertType} alert found`);
            }

            return alert;
        } catch (error) {
            console.error(`🔥 Error getting last ${alertType} alert:`, error);
            return null;
        }
    }

    /**
     * Create a device alert and send notification
     */
    async createAlert(vehicle, user, alarmData, alarmConfig) {
        try {
            console.log('💾 Creating alert in database...');

            const vehicleName = vehicle.nickname || vehicle.model || `GPS-${vehicle.mac_id_gps}`;
            const message = alarmConfig.getMessage(vehicleName);
            console.log(`📝 Alert Message: ${message}`);

            // Get location from alarm data if available
            const latitude = alarmData.weidu || alarmData.latitude || null;
            const longitude = alarmData.jingdu || alarmData.longitude || null;

            console.log(`📍 Location: ${latitude}, ${longitude}`);

            // Create alert in database
            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: alarmConfig.type,
                message: message,
                alert_status: 'ACTIVE',
                latitude: latitude,
                longitude: longitude,
                alerted_at: new Date(),
                read: false,
                sent: false,
                processed: false
            });

            console.log(`✅ ✅ ✅ ${alarmConfig.type} alert saved to database with ID: ${alert.id}`);
            console.log(`📊 Alert Details:`, {
                id: alert.id,
                voiture_id: alert.voiture_id,
                alert_type: alert.alert_type,
                message: alert.message,
                severity: alarmConfig.severity,
                alert_status: alert.alert_status,
                latitude: alert.latitude,
                longitude: alert.longitude,
                alerted_at: alert.alerted_at
            });

            // Send push notification via Firebase
            if (user.fcm_token) {
                console.log('📲 Sending Firebase notification...');
                await firebaseService.sendNotification(
                    user.fcm_token,
                    alarmConfig.title,
                    message,
                    {
                        type: alarmConfig.type,
                        severity: alarmConfig.severity,
                        vehicleId: vehicle.id.toString(),
                        alertId: alert.id.toString(),
                        latitude: latitude ? latitude.toString() : '',
                        longitude: longitude ? longitude.toString() : ''
                    }
                );
                console.log('✅ Firebase notification sent successfully');
            } else {
                console.log('⚠️ No FCM token found, skipping push notification');
            }

            return alert;
        } catch (error) {
            console.error(`🔥 Error creating ${alarmConfig.type} alert:`, error);
            console.error('🔥 Error details:', error.message);
            return null;
        }
    }

    /**
     * Check if an alarm type is supported
     */
    isAlarmSupported(typeId) {
        const parsedTypeId = parseInt(typeId);
        return this.ALARM_CONFIG.hasOwnProperty(parsedTypeId);
    }

    /**
     * Get all supported alarm type IDs
     */
    getSupportedAlarmTypes() {
        return Object.values(this.ALARM_TYPES);
    }

    /**
     * Get alarm configuration by type ID
     */
    getAlarmConfig(typeId) {
        return this.ALARM_CONFIG[parseInt(typeId)] || null;
    }
}

module.exports = new DeviceAlertService();