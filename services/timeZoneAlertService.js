// services/timeZoneAlertService.js
const Alert = require("../models/Alert");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const NotificationService = require("../controllers/notificationController");

class TimeZoneAlertService {
    // Cooldown period in minutes
    static ALERT_COOLDOWN_MINUTES = 10;

    // Minimum speed to consider vehicle as "moving" (km/h
    static MIN_MOVEMENT_SPEED = 1;

    /**
     * Check if vehicle is moving during restricted time zone
     */
    static async checkTimeZoneViolation(vehicleId, macIdGps, currentSpeed, location) {
        try {
            console.log(`🕐 Checking time zone for vehicle ${vehicleId}`);

            // Get vehicle with time zone settings
            const vehicle = await Voiture.findByPk(vehicleId, {
                attributes: ['id', 'time_zone_start', 'time_zone_end', 'nickname', 'immatriculation', 'marque', 'model']
            });

            if (!vehicle) {
                console.log(`⚠️ Vehicle ${vehicleId} not found`);
                return;
            }

            // Check if time zone is configured
            if (!vehicle.time_zone_start || !vehicle.time_zone_end) {
                console.log(`⏭️ No time zone restriction set for vehicle ${vehicleId}`);
                return;
            }

            // Check if vehicle is moving
            const actualSpeed = parseFloat(currentSpeed || 0);
            if (actualSpeed < this.MIN_MOVEMENT_SPEED) {
                console.log(`✅ Vehicle stationary (${actualSpeed} km/h)`);
                return;
            }

            // Get current time
            const now = new Date();
            const currentTime = now.toTimeString().split(' ')[0]; // HH:MM:SS format

            // Check if current time is within restricted zone
            const isInRestrictedZone = this.isTimeInRestrictedZone(
                currentTime,
                vehicle.time_zone_start,
                vehicle.time_zone_end
            );

            if (!isInRestrictedZone) {
                console.log(`✅ Current time ${currentTime} is outside restricted zone (${vehicle.time_zone_start} - ${vehicle.time_zone_end})`);
                return;
            }

            console.log(`⚠️ TIME ZONE VIOLATION DETECTED! Vehicle moving at ${currentTime} (restricted: ${vehicle.time_zone_start} - ${vehicle.time_zone_end})`);

            // Check for recent alerts (cooldown)
            const recentAlert = await this.getLastTimeZoneAlert(vehicleId);

            if (recentAlert) {
                const minutesSinceLastAlert = (new Date() - new Date(recentAlert.alerted_at)) / 60000;

                if (minutesSinceLastAlert < this.ALERT_COOLDOWN_MINUTES) {
                    console.log(`⏳ Cooldown active: ${minutesSinceLastAlert.toFixed(1)} min since last alert`);
                    return;
                }
            }

            // Get user to check if alerts are enabled
            const assoc = await AssocUserVoitures.findOne({
                where: { voiture_id: vehicleId },
                attributes: ['user_id']
            });

            if (!assoc) {
                console.log(`⚠️ No user found for vehicle ${vehicleId}`);
                return;
            }

            const user = await User.findByPk(assoc.user_id, {
                attributes: ['id', 'nom', 'prenom', 'time_zone_alerts_enabled']
            });

            if (!user || !user.time_zone_alerts_enabled) {
                console.log(`🚫 Time zone alerts disabled for user ${assoc.user_id}`);
                return;
            }

            // Create alert
            await this.createTimeZoneAlert(vehicle, currentTime, actualSpeed, location, user.id);

        } catch (error) {
            console.error("❌ Error checking time zone violation:", error);
            console.error("❌ Stack trace:", error.stack);
        }
    }

    /**
     * Check if current time falls within restricted time zone
     */
    static isTimeInRestrictedZone(currentTime, startTime, endTime) {
        // Convert time strings to comparable format (remove milliseconds if present)
        const current = currentTime.substring(0, 8);
        const start = startTime.substring(0, 8);
        const end = endTime.substring(0, 8);

        // Case 1: Normal range (e.g., 22:00:00 to 06:00:00 next day)
        if (start > end) {
            // Crosses midnight
            return current >= start || current <= end;
        }

        // Case 2: Same day range (e.g., 09:00:00 to 17:00:00)
        return current >= start && current <= end;
    }

    /**
     * Get last time zone alert for vehicle
     */
    static async getLastTimeZoneAlert(vehicleId) {
        try {
            return await Alert.findOne({
                where: {
                    voiture_id: vehicleId,
                    alert_type: 'time_zone'
                },
                order: [['alerted_at', 'DESC']]
            });
        } catch (error) {
            console.error("❌ Error fetching last time zone alert:", error);
            return null;
        }
    }

    /**
     * Create time zone violation alert
     */
    static async createTimeZoneAlert(vehicle, violationTime, speed, location, userId) {
        try {
            const vehicleName = vehicle.nickname || vehicle.immatriculation || `${vehicle.marque} ${vehicle.model}`;

            const message = `Vehicle ${vehicleName} moved during restricted hours at ${violationTime} (Restricted: ${vehicle.time_zone_start} - ${vehicle.time_zone_end})`;

            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: 'time_zone',
                message: message,
                alerted_at: new Date(),
                latitude: location.latitude || null,
                longitude: location.longitude || null,
                sent: false,
                read: false,
                processed: false
            });

            console.log(`✅ Time zone alert created: ${alert.id}`);

            // Send notification
            await NotificationService.sendToUser(userId, {
                title: '🕐 Restricted Hours Violation',
                body: message,
                data: {
                    type: 'time_zone',
                    vehicleId: String(vehicle.id),
                    alertId: String(alert.id),
                    timestamp: new Date().toISOString()
                }
            });

            // Mark as sent
            await alert.update({ sent: true });

            console.log(`📧 Time zone alert notification sent to user ${userId}`);

        } catch (error) {
            console.error("❌ Error creating time zone alert:", error);
            console.error("❌ Stack trace:", error.stack);
        }
    }
}

module.exports = TimeZoneAlertService;