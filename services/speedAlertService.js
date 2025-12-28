// services/speedAlertService.js
const Alert = require("../models/Alert");
const Voiture = require("../models/voiture");
const User = require("../models/userModel");
const AssocUserVoitures = require("../models/AssociationUserVoiture");
const NotificationService = require("./notificationService");
const { Op } = require("sequelize");

class SpeedAlertService {
    // Cooldown period in minutes
    static ALERT_COOLDOWN_MINUTES = 10;

    /**
     * Check if vehicle has exceeded speed limit
     */
    static async checkSpeedViolation(vehicleId, macIdGps, currentSpeed, location) {
        try {
            console.log(`🚗 Checking speed for vehicle ${vehicleId}: ${currentSpeed} km/h`);

            // Get vehicle with speed zone limit
            const vehicle = await Voiture.findByPk(vehicleId, {
                attributes: ['id', 'speed_zone', 'nickname', 'immatriculation', 'marque', 'model']
            });

            if (!vehicle) {
                console.log(`⚠️ Vehicle ${vehicleId} not found`);
                return;
            }

            // Check if speed zone is configured
            if (!vehicle.speed_zone || vehicle.speed_zone <= 0) {
                console.log(`⏭️ No speed limit set for vehicle ${vehicleId}`);
                return;
            }

            const speedLimit = parseFloat(vehicle.speed_zone);
            const actualSpeed = parseFloat(currentSpeed || 0);

            console.log(`🎯 Speed check: ${actualSpeed} km/h | Limit: ${speedLimit} km/h`);

            // Check if speed exceeded
            if (actualSpeed <= speedLimit) {
                console.log(`✅ Speed within limit`);
                return;
            }

            console.log(`⚠️ SPEED VIOLATION DETECTED! ${actualSpeed} km/h > ${speedLimit} km/h`);

            // Check for recent alerts (cooldown)
            const recentAlert = await this.getLastSpeedAlert(vehicleId);

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
                attributes: ['id', 'nom', 'prenom', 'speed_alerts_enabled']
            });

            if (!user || !user.speed_alerts_enabled) {
                console.log(`🚫 Speed alerts disabled for user ${assoc.user_id}`);
                return;
            }

            // Create alert
            await this.createSpeedAlert(vehicle, actualSpeed, speedLimit, location, user.id);

        } catch (error) {
            console.error("❌ Error checking speed violation:", error);
            console.error("❌ Stack trace:", error.stack);
        }
    }

    /**
     * Get last speed alert for vehicle
     */
    static async getLastSpeedAlert(vehicleId) {
        try {
            return await Alert.findOne({
                where: {
                    voiture_id: vehicleId,
                    alert_type: 'speed'
                },
                order: [['alerted_at', 'DESC']]
            });
        } catch (error) {
            console.error("❌ Error fetching last speed alert:", error);
            return null;
        }
    }

    /**
     * Create speed violation alert
     */
    static async createSpeedAlert(vehicle, actualSpeed, speedLimit, location, userId) {
        try {
            const vehicleName = vehicle.nickname || vehicle.immatriculation || `${vehicle.marque} ${vehicle.model}`;
            const overspeed = (actualSpeed - speedLimit).toFixed(1);

            const message = `Vehicle ${vehicleName} exceeded speed limit: ${actualSpeed.toFixed(1)} km/h in ${speedLimit} km/h zone (+${overspeed} km/h)`;

            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: 'speed',
                message: message,
                alerted_at: new Date(),
                latitude: location.latitude || null,
                longitude: location.longitude || null,
                sent: false,
                read: false,
                processed: false
            });

            console.log(`✅ Speed alert created: ${alert.id}`);

            // ✅ FIXED: Use the correct method from NotificationService
            await NotificationService.sendSpeedingAlert(
                userId,
                vehicleName,
                actualSpeed,
                speedLimit
            );

            // Mark as sent
            await alert.update({ sent: true });

            console.log(`📧 Speed alert notification sent to user ${userId}`);

        } catch (error) {
            console.error("❌ Error creating speed alert:", error);
            console.error("❌ Stack trace:", error.stack);
        }
    }
}

module.exports = SpeedAlertService;