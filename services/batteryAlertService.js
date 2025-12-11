// services/batteryAlertService.js
const { Voiture } = require('../models/voiture');
const { Alert } = require('../models/alert');
const { User } = require('../models/userModel');
const firebaseService = require('./notificationService');

class BatteryAlertService {
    constructor() {
        this.LOW_BATTERY_PERCENTAGE = 20; // Alert when battery below 20%
        this.LOW_BATTERY_VOLTAGE = 3.6;   // Alert when voltage below 3.6V
        this.ALERT_COOLDOWN_MINUTES = 60; // Send alert only once per hour
    }


    async checkBatteryLevel(vehicleData, statenumber) {
        try {
            // Parse statenumber to get battery info
            // Format: "mil,oil,weight,temp,batteryV,powerV,gpscount,gsmlevel,..."
            const stateArray = statenumber.split(',');

            if (stateArray.length < 5) {
                console.log('⚠️ Statenumber format invalid for battery check');
                return;
            }

            const batteryValue = parseFloat(stateArray[4]) || 0;

            if (batteryValue === 0) {
                return; // No battery data available
            }

            // Determine if it's percentage or voltage
            let batteryPercentage = 0;
            let batteryVoltage = 0;
            let isLowBattery = false;

            if (batteryValue < 100) {
                // It's a percentage
                batteryPercentage = batteryValue;
                isLowBattery = batteryPercentage < this.LOW_BATTERY_PERCENTAGE;
            } else {
                // It's voltage (subtract 100 to get actual voltage)
                batteryVoltage = batteryValue - 100;
                isLowBattery = batteryVoltage < this.LOW_BATTERY_VOLTAGE;
            }

            if (!isLowBattery) {
                return; // Battery level is good
            }

            // Check if user has battery alerts enabled
            const vehicle = await Voiture.findByPk(vehicleData.id);
            if (!vehicle) return;

            const user = await User.findOne({ where: { id: vehicle.utilisateur_id } });
            if (!user || !user.battery_alerts_enabled) {
                console.log(`⚠️ Battery alerts disabled for vehicle ${vehicle.nickname}`);
                return;
            }

            // Check cooldown - don't spam alerts
            const lastAlert = await this.getLastBatteryAlert(vehicleData.id);
            if (lastAlert) {
                const minutesSinceLastAlert = (Date.now() - new Date(lastAlert.alerted_at).getTime()) / (1000 * 60);
                if (minutesSinceLastAlert < this.ALERT_COOLDOWN_MINUTES) {
                    console.log(`⏳ Battery alert cooldown active for vehicle ${vehicle.nickname} (${Math.round(minutesSinceLastAlert)}min ago)`);
                    return;
                }
            }

            // Create battery alert
            await this.createBatteryAlert(vehicle, batteryPercentage, batteryVoltage);

            console.log(`🔋 Low battery alert created for vehicle ${vehicle.nickname}`);

        } catch (error) {
            console.error('🔥 Error checking battery level:', error);
        }
    }

    /**
     * Get the last battery alert for a vehicle
     */
    async getLastBatteryAlert(vehicleId) {
        try {
            const alert = await Alert.findOne({
                where: {
                    voiture_id: vehicleId,
                    alert_type: 'battery'
                },
                order: [['alerted_at', 'DESC']]
            });

            return alert;
        } catch (error) {
            console.error('🔥 Error getting last battery alert:', error);
            return null;
        }
    }

    /**
     * Create a low battery alert
     */
    async createBatteryAlert(vehicle, batteryPercentage, batteryVoltage) {
        try {
            // Format message based on whether we have percentage or voltage
            let message;
            if (batteryPercentage > 0) {
                message = `Vehicle ${vehicle.nickname} has low battery: ${batteryPercentage}% remaining`;
            } else {
                message = `Vehicle ${vehicle.nickname} has low battery: ${batteryVoltage.toFixed(1)}V`;
            }

            // Create alert in database
            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: 'battery',
                message: message,
                alert_status: 'active',
                alerted_at: new Date(),
                read: false
            });

            // Send push notification via Firebase
            const user = await User.findOne({ where: { id: vehicle.utilisateur_id } });
            if (user && user.fcm_token) {
                await firebaseService.sendNotification(
                    user.fcm_token,
                    'Low Battery Alert',
                    message,
                    {
                        type: 'battery',
                        vehicleId: vehicle.id.toString(),
                        alertId: alert.id.toString(),
                        batteryLevel: batteryPercentage > 0 ? `${batteryPercentage}%` : `${batteryVoltage}V`
                    }
                );
            }

            return alert;
        } catch (error) {
            console.error('🔥 Error creating battery alert:', error);
            return null;
        }
    }

    /**
     * Parse battery info from statenumber string
     * @param {string} statenumber - Status string from GPS device
     * @returns {Object} - { percentage, voltage, isLow }
     */
    static parseBatteryInfo(statenumber) {
        try {
            if (!statenumber) return { percentage: 0, voltage: 0, isLow: false };

            const stateArray = statenumber.split(',');
            if (stateArray.length < 5) return { percentage: 0, voltage: 0, isLow: false };

            const batteryValue = parseFloat(stateArray[4]) || 0;

            if (batteryValue === 0) {
                return { percentage: 0, voltage: 0, isLow: false };
            }

            let percentage = 0;
            let voltage = 0;

            if (batteryValue < 100) {
                percentage = batteryValue;
            } else {
                voltage = batteryValue - 100;
                // Estimate percentage from voltage (rough approximation)
                // 4.2V = 100%, 3.7V = 50%, 3.3V = 0%
                percentage = Math.max(0, Math.min(100, ((voltage - 3.3) / (4.2 - 3.3)) * 100));
            }

            const isLow = percentage < 20 || voltage < 3.6;

            return {
                percentage: Math.round(percentage),
                voltage: voltage,
                isLow
            };
        } catch (error) {
            console.error('🔥 Error parsing battery info:', error);
            return { percentage: 0, voltage: 0, isLow: false };
        }
    }
}

module.exports = new BatteryAlertService();