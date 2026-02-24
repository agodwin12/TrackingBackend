// services/batteryMonitoringService.js
const Voiture = require('../models/voiture');
const Alert = require('../models/alert');
const User = require('../models/userModel');
const firebaseService = require('./notificationService');
const sequelize = require('../config/database');

class BatteryMonitoringService {
    constructor() {
        // Battery alert thresholds (descending order)
        this.BATTERY_THRESHOLDS = [25, 20, 15, 10, 5, 0];

        // Cooldown to prevent spam (5 minutes between same-level alerts)
        this.ALERT_COOLDOWN_MINUTES = 5;

        // Cache to track last known battery level per vehicle
        this.vehicleBatteryCache = new Map();
    }

    // ✅ Only the columns that actually exist in the voitures table
    get VOITURE_ATTRIBUTES() {
        return [
            'id',
            'voiture_unique_id',
            'immatriculation',
            'mac_id_gps',
            'marque',
            'model',
            'couleur',
            'photo',
            'time_zone_start',
            'time_zone_end',
            'speed_zone',
            'region_id',
            'region_name',
            'geofence_zone',
            'nickname',
            'latitude',
            'longitude',
            'battery_level',
            'last_battery_check',
            'created_at',
            'updated_at'
        ];
    }

    /**
     * Process battery level from GPS update
     * @param {Object} gpsData - GPS data containing statenumber field
     * @param {string} macId - Vehicle MAC ID
     */
    async processBatteryLevel(gpsData, macId) {
        try {
            console.log('\n🔋 ========== BATTERY MONITORING CHECK STARTED ==========');
            console.log(`📍 MAC ID: ${macId}`);

            // Extract battery level from statenumber field
            const batteryLevel = this.extractBatteryLevel(gpsData);

            if (batteryLevel === null) {
                console.log('⚠️ Could not extract battery level from GPS data');
                console.log('🔋 ========== BATTERY MONITORING CHECK ENDED ==========\n');
                return;
            }

            console.log(`🔋 Current Battery Level: ${batteryLevel}%`);

            // ✅ Only fetch columns that exist in the table
            const vehicle = await Voiture.findOne({
                where: { mac_id_gps: macId },
                attributes: this.VOITURE_ATTRIBUTES
            });

            if (!vehicle) {
                console.log(`❌ Vehicle not found with MAC ID: ${macId}`);
                console.log('🔋 ========== BATTERY MONITORING CHECK ENDED ==========\n');
                return;
            }

            console.log(`✅ Vehicle found: ${vehicle.nickname} (ID: ${vehicle.id})`);

            // Get last known battery level
            const lastBatteryLevel = this.vehicleBatteryCache.get(vehicle.id);
            console.log(`📊 Last Known Battery Level: ${lastBatteryLevel !== undefined ? lastBatteryLevel + '%' : 'Unknown (first check)'}`);

            // Update battery level in vehicle table
            await vehicle.update({
                battery_level: batteryLevel,
                last_battery_check: new Date()
            });
            console.log(`💾 Battery level saved to vehicle record`);

            // Check for threshold crossings
            if (lastBatteryLevel !== undefined) {
                await this.checkThresholdCrossings(vehicle, lastBatteryLevel, batteryLevel, gpsData);
            } else {
                console.log('ℹ️ First battery reading for this vehicle - checking current threshold');
                await this.checkInitialThreshold(vehicle, batteryLevel, gpsData);
            }

            // Update cache with current level
            this.vehicleBatteryCache.set(vehicle.id, batteryLevel);
            console.log(`💾 Battery level cached for future comparisons`);

            console.log('🔋 ========== BATTERY MONITORING CHECK ENDED ==========\n');

        } catch (error) {
            console.error('🔥 Error processing battery level:', error);
            console.error('🔥 Stack trace:', error.stack);
            console.log('🔋 ========== BATTERY MONITORING CHECK ENDED (ERROR) ==========\n');
        }
    }

    /**
     * Extract battery percentage from statenumber field
     * @param {Object} gpsData - GPS data object
     * @returns {number|null} Battery percentage or null if not found
     */
    extractBatteryLevel(gpsData) {
        try {
            const statenumber = gpsData.statenumber || gpsData.StateNumber;

            if (!statenumber) {
                console.log('⚠️ No statenumber field in GPS data');
                return null;
            }

            console.log(`📊 Raw statenumber: ${statenumber}`);

            const values = statenumber.split(',');

            if (values.length < 5) {
                console.log(`⚠️ Statenumber has insufficient values (${values.length}), expected at least 5`);
                return null;
            }

            const batteryValue = parseFloat(values[4]);

            if (isNaN(batteryValue)) {
                console.log(`⚠️ Invalid battery value at index 4: ${values[4]}`);
                return null;
            }

            console.log(`🔍 Raw battery value: ${batteryValue}`);

            let batteryPercentage;

            if (batteryValue < 100) {
                batteryPercentage = batteryValue;
                console.log(`✅ Battery value is percentage: ${batteryPercentage}%`);
            } else {
                const voltage = batteryValue - 100;
                console.log(`⚡ Battery value is voltage: ${voltage}V`);
                batteryPercentage = Math.max(0, Math.min(100, ((voltage - 11.8) / (12.6 - 11.8)) * 100));
                console.log(`🔄 Converted to percentage: ${batteryPercentage.toFixed(1)}%`);
            }

            return Math.round(batteryPercentage);

        } catch (error) {
            console.error('🔥 Error extracting battery level:', error);
            return null;
        }
    }

    /**
     * Check for battery threshold crossings
     */
    async checkThresholdCrossings(vehicle, oldLevel, newLevel, gpsData) {
        console.log(`\n🔍 Checking threshold crossings: ${oldLevel}% → ${newLevel}%`);

        if (newLevel < oldLevel) {
            console.log('📉 Battery level is DROPPING');
            for (const threshold of this.BATTERY_THRESHOLDS) {
                if (oldLevel > threshold && newLevel <= threshold) {
                    console.log(`⚠️ CROSSED THRESHOLD: ${threshold}% (going down)`);
                    await this.createBatteryAlert(vehicle, newLevel, threshold, 'low', gpsData);
                }
            }
        } else if (newLevel > oldLevel) {
            console.log('📈 Battery level is RECOVERING');
            for (const threshold of this.BATTERY_THRESHOLDS) {
                if (oldLevel <= threshold && newLevel > threshold) {
                    console.log(`✅ CROSSED THRESHOLD: ${threshold}% (going up - RECOVERY)`);
                    await this.createBatteryAlert(vehicle, newLevel, threshold, 'recovery', gpsData);
                }
            }
        } else {
            console.log('➡️ Battery level unchanged');
        }
    }

    /**
     * Check initial threshold for first reading
     */
    async checkInitialThreshold(vehicle, currentLevel, gpsData) {
        console.log(`\n🔍 Checking initial battery threshold: ${currentLevel}%`);

        for (const threshold of this.BATTERY_THRESHOLDS) {
            if (currentLevel <= threshold) {
                console.log(`⚠️ Battery is at or below ${threshold}% threshold`);
                await this.createBatteryAlert(vehicle, currentLevel, threshold, 'low', gpsData);
                break;
            }
        }
    }

    /**
     * Create battery alert with cooldown check
     */
    async createBatteryAlert(vehicle, batteryLevel, threshold, direction, gpsData) {
        try {
            const alertType = direction === 'recovery' ? 'battery_recovery' : 'low_battery';
            console.log(`\n🚨 Creating ${alertType} alert for ${threshold}% threshold...`);

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
                return;
            }

            console.log(`✅ User found: ${user.nom} ${user.prenom} (ID: ${user.id})`);

            const lastAlert = await this.getLastBatteryAlert(vehicle.id, threshold, direction);

            if (lastAlert) {
                const minutesSinceLastAlert = (Date.now() - new Date(lastAlert.alerted_at).getTime()) / (1000 * 60);
                console.log(`📅 Last similar alert was ${Math.round(minutesSinceLastAlert)} minutes ago`);

                if (minutesSinceLastAlert < this.ALERT_COOLDOWN_MINUTES) {
                    console.log(`⏳ Alert cooldown active (${this.ALERT_COOLDOWN_MINUTES} min), skipping alert`);
                    return;
                }
            }

            const message = this.getAlertMessage(vehicle.nickname, batteryLevel, threshold, direction);
            const title = direction === 'recovery' ? 'Battery Recovering' : 'Low Battery Warning';
            const severity = this.getSeverity(threshold, direction);
            const emoji = direction === 'recovery' ? '🔋✅' : '🔋⚠️';

            console.log(`📝 Alert Message: ${message}`);
            console.log(`⚠️ Severity: ${severity}`);

            const latitude = gpsData.weidu || gpsData.latitude || null;
            const longitude = gpsData.jingdu || gpsData.longitude || null;

            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: alertType,
                message: message,
                alert_status: 'ACTIVE',
                latitude: latitude,
                longitude: longitude,
                alerted_at: new Date(),
                read: false,
                metadata: JSON.stringify({
                    battery_level: batteryLevel,
                    threshold: threshold,
                    direction: direction,
                    severity: severity
                })
            });

            console.log(`✅ ${emoji} Battery alert saved to database with ID: ${alert.id}`);

            if (user.fcm_token) {
                console.log('📲 Sending Firebase notification...');
                await firebaseService.sendNotification(
                    user.fcm_token,
                    title,
                    message,
                    {
                        type: alertType,
                        severity: severity,
                        vehicleId: vehicle.id.toString(),
                        alertId: alert.id.toString(),
                        batteryLevel: batteryLevel.toString(),
                        threshold: threshold.toString(),
                        latitude: latitude ? latitude.toString() : '',
                        longitude: longitude ? longitude.toString() : ''
                    }
                );
                console.log('✅ Firebase notification sent successfully');
            } else {
                console.log('⚠️ No FCM token found, skipping push notification');
            }

        } catch (error) {
            console.error('🔥 Error creating battery alert:', error);
            console.error('🔥 Error details:', error.message);
        }
    }

    /**
     * Get last battery alert of specific threshold and direction
     */
    async getLastBatteryAlert(vehicleId, threshold, direction) {
        try {
            const alertType = direction === 'recovery' ? 'battery_recovery' : 'battery_low';

            const alert = await Alert.findOne({
                where: {
                    voiture_id: vehicleId,
                    alert_type: alertType
                },
                order: [['alerted_at', 'DESC']]
            });

            if (alert && alert.metadata) {
                const metadata = JSON.parse(alert.metadata);
                if (metadata.threshold === threshold) {
                    return alert;
                }
            }

            return null;
        } catch (error) {
            console.error('🔥 Error getting last battery alert:', error);
            return null;
        }
    }

    /**
     * Generate alert message based on battery level and direction
     */
    getAlertMessage(vehicleName, batteryLevel, threshold, direction) {
        if (direction === 'recovery') {
            return `Battery recovering for ${vehicleName}. Battery level is now ${batteryLevel}% (above ${threshold}% threshold)`;
        }

        if (threshold === 0) {
            return `🚨 CRITICAL: ${vehicleName} battery is DEAD (${batteryLevel}%)! Device may shut down soon!`;
        } else if (threshold <= 5) {
            return `🚨 URGENT: ${vehicleName} battery critically low at ${batteryLevel}%! Charge immediately!`;
        } else if (threshold <= 10) {
            return `⚠️ WARNING: ${vehicleName} battery very low at ${batteryLevel}%. Please charge soon.`;
        } else if (threshold <= 15) {
            return `⚠️ ${vehicleName} battery running low at ${batteryLevel}%. Consider charging.`;
        } else {
            return `🔋 ${vehicleName} battery at ${batteryLevel}%. Below ${threshold}% threshold.`;
        }
    }

    /**
     * Get severity level based on threshold
     */
    getSeverity(threshold, direction) {
        if (direction === 'recovery') return 'info';
        if (threshold === 0) return 'critical';
        if (threshold <= 5) return 'critical';
        if (threshold <= 10) return 'high';
        if (threshold <= 15) return 'medium';
        return 'warning';
    }

    /**
     * Clear battery cache for a vehicle
     */
    clearCache(vehicleId) {
        this.vehicleBatteryCache.delete(vehicleId);
        console.log(`🗑️ Battery cache cleared for vehicle ${vehicleId}`);
    }

    /**
     * Get cached battery level for a vehicle
     */
    getCachedLevel(vehicleId) {
        return this.vehicleBatteryCache.get(vehicleId);
    }
}

module.exports = new BatteryMonitoringService();