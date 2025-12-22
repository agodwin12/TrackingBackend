// controllers/geofenceMonitorController.js

const VehicleSecurity = require('../models/vehicleSecurity');
const Alert = require('../models/Alert');
const notificationController = require('./notificationController');
const sequelize = require('../config/database');
const { isInsideGeofence } = require('../services/geofenceService');
const socketService = require('../services/socketService');
const axios = require('axios');

// Google Maps API key for geocoding
const GOOGLE_MAPS_API_KEY = 'AIzaSyBn88TP5X-xaRCYo5gYxvGnVy_0WYotZWo';

// ✅ Cooldown period for geofence alerts (in minutes)
const GEOFENCE_ALERT_COOLDOWN_MINUTES = 30; // Send alert every 30 minutes if still outside

/**
 * ✅ Get user alert settings from users table
 */
const getUserAlertSettings = async (userId) => {
    try {
        console.log(`🔍 Fetching alert settings for user ${userId}`);

        const [user] = await sequelize.query(
            'SELECT geofence_alerts_enabled, safe_zone_alerts_enabled FROM users WHERE id = ? LIMIT 1',
            {
                replacements: [userId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (user) {
            const settings = {
                geofenceAlertsEnabled: user.geofence_alerts_enabled !== false, // Default true if NULL
                safeZoneAlertsEnabled: user.safe_zone_alerts_enabled !== false, // Default true if NULL
            };

            console.log(`✅ Alert settings retrieved for user ${userId}:`, settings);
            return settings;
        }

        // User not found - default to all alerts enabled
        console.warn(`⚠️ User ${userId} not found, using default settings`);
        return {
            geofenceAlertsEnabled: true,
            safeZoneAlertsEnabled: true,
        };
    } catch (error) {
        console.error(`❌ Error fetching user alert settings for user ${userId}:`, error);
        // On error, default to enabled (fail-safe)
        return {
            geofenceAlertsEnabled: true,
            safeZoneAlertsEnabled: true,
        };
    }
};

/**
 * Reverse geocode coordinates to get location name
 */
const reverseGeocode = async (latitude, longitude) => {
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                latlng: `${latitude},${longitude}`,
                key: GOOGLE_MAPS_API_KEY,
                language: 'en'
            },
            timeout: 5000
        });

        if (response.data.status === 'OK' && response.data.results.length > 0) {
            const result = response.data.results[0];

            const formattedAddress = result.formatted_address;

            let locality = null;
            for (const component of result.address_components) {
                if (component.types.includes('locality')) {
                    locality = component.long_name;
                    break;
                } else if (component.types.includes('administrative_area_level_2')) {
                    locality = component.long_name;
                } else if (component.types.includes('administrative_area_level_1')) {
                    if (!locality) locality = component.long_name;
                }
            }

            console.log(`📍 Geocoded: ${formattedAddress}`);

            return {
                formattedAddress: formattedAddress,
                locality: locality || formattedAddress.split(',')[0],
                success: true
            };
        } else {
            console.warn(`⚠️ Geocoding failed: ${response.data.status}`);
            return {
                formattedAddress: `${latitude}, ${longitude}`,
                locality: `${latitude}, ${longitude}`,
                success: false
            };
        }
    } catch (error) {
        console.error(`❌ Geocoding error:`, error.message);
        return {
            formattedAddress: `${latitude}, ${longitude}`,
            locality: `${latitude}, ${longitude}`,
            success: false
        };
    }
};

/**
 * Get the last geofence alert for a vehicle
 */
const getLastGeofenceAlert = async (vehicleId) => {
    try {
        console.log(`🔍 Querying last geofence alert for vehicle ${vehicleId}...`);

        const [alert] = await sequelize.query(
            `SELECT id, alerted_at, message
             FROM alerts
             WHERE voiture_id = ?
               AND alert_type = 'geofence'
             ORDER BY alerted_at DESC
                 LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (alert) {
            console.log(`✅ Found last alert: ID ${alert.id}, created at ${alert.alerted_at}`);
        } else {
            console.log(`ℹ️ No previous geofence alert found`);
        }

        return alert;
    } catch (error) {
        console.error('🔥 Error getting last geofence alert:', error);
        return null;
    }
};

/**
 * Check if vehicle has left its geofence zone
 */
const checkGeofenceViolation = async (vehicleId, latitude, longitude) => {
    try {
        console.log(`🔍 Checking geofence for vehicle ${vehicleId} at [${latitude}, ${longitude}]`);

        // Step 1: Get vehicle data using raw query
        const [voiture] = await sequelize.query(
            'SELECT id, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voiture) {
            console.warn(`⚠️ Vehicle ${vehicleId} not found`);
            return { violation: false, reason: 'Vehicle not found' };
        }

        // Step 2: Check if geofencing is active using raw query
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!security || !security.is_active) {
            console.log(`ℹ️ Geofencing not active for vehicle ${vehicleId}`);
            return { violation: false, reason: 'Geofencing not active' };
        }

        console.log(`✅ Geofencing is ACTIVE for vehicle ${vehicleId}`);

        // Step 3: Check if vehicle has a geofence zone defined
        if (!voiture.geofence_zone) {
            console.warn(`⚠️ No geofence zone defined for vehicle ${vehicleId}`);
            return { violation: false, reason: 'No geofence defined' };
        }

        console.log(`✅ Geofence zone found for vehicle ${vehicleId}`);

        // Step 4: Parse geofence zone
        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone)
                : voiture.geofence_zone;

            console.log(`✅ Geofence zone parsed successfully (${geofenceZone.length} points)`);
        } catch (parseError) {
            console.error(`❌ Error parsing geofence zone for vehicle ${vehicleId}:`, parseError);
            return { violation: false, reason: 'Invalid geofence data' };
        }

        // Step 5: Check if vehicle is inside the geofence
        const isInside = isInsideGeofence(latitude, longitude, geofenceZone);

        console.log(`📍 Vehicle ${vehicleId} is ${isInside ? 'INSIDE' : 'OUTSIDE'} geofence`);

        // ✅ If vehicle is INSIDE, no violation - clear any active alerts
        if (isInside) {
            console.log(`✅ Vehicle ${vehicleId} is INSIDE geofence - no violation`);
            return { violation: false, reason: 'Vehicle inside geofence' };
        }

        // ✅ Vehicle is OUTSIDE - check cooldown before creating alert
        console.log(`🚨 Vehicle ${vehicleId} is OUTSIDE geofence - checking cooldown...`);

        const lastAlert = await getLastGeofenceAlert(vehicleId);

        if (lastAlert) {
            const minutesSinceLastAlert = (Date.now() - new Date(lastAlert.alerted_at).getTime()) / (1000 * 60);
            console.log(`📅 Last geofence alert was ${Math.round(minutesSinceLastAlert)} minutes ago`);
            console.log(`⏰ Cooldown period: ${GEOFENCE_ALERT_COOLDOWN_MINUTES} minutes`);

            if (minutesSinceLastAlert < GEOFENCE_ALERT_COOLDOWN_MINUTES) {
                console.log(`⏳ Geofence alert cooldown active for vehicle ${vehicleId}`);
                console.log(`⏳ Time remaining: ${Math.round(GEOFENCE_ALERT_COOLDOWN_MINUTES - minutesSinceLastAlert)} minutes`);
                return {
                    violation: true,
                    reason: 'Cooldown active',
                    isFirstAlert: false
                };
            }
            console.log('✅ Cooldown period expired, proceeding with alert');
        } else {
            console.log('✅ No previous geofence alert found, proceeding with alert');
        }

        // Get vehicle name
        const vehicleName = voiture.nickname || `${voiture.marque} ${voiture.model}`;

        // Get user ID
        const [vehicleOwner] = await sequelize.query(
            `SELECT user_id FROM association_user_voitures WHERE voiture_id = ? LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!vehicleOwner || !vehicleOwner.user_id) {
            console.warn(`⚠️ No owner found for vehicle ${vehicleId}`);
            return { violation: true, reason: 'No owner found' };
        }

        const userId = vehicleOwner.user_id;
        console.log(`✅ Found owner (user ${userId}) for vehicle ${vehicleId}`);

        // ✅ Check if geofence alerts are enabled for this user
        const alertSettings = await getUserAlertSettings(userId);

        if (!alertSettings.geofenceAlertsEnabled) {
            console.log(`🔕 Geofence alerts DISABLED for user ${userId} - alert created but NO notification sent`);

            // Get location name
            const locationInfo = await reverseGeocode(latitude, longitude);

            // Create alert in database (for history) but DON'T send notification
            await createGeofenceAlert(vehicleId, vehicleName, latitude, longitude, locationInfo, false);

            return {
                violation: true,
                reason: 'Alert created but notifications disabled',
                alertsSent: false,
                vehicleName,
                latitude,
                longitude,
                locationName: locationInfo.locality,
                userId,
                isFirstAlert: true
            };
        }

        // Get location name
        const locationInfo = await reverseGeocode(latitude, longitude);

        // Create alert in database
        await createGeofenceAlert(vehicleId, vehicleName, latitude, longitude, locationInfo, true);

        // Send push notification (alerts enabled)
        await sendGeofencePushNotification(userId, vehicleId, vehicleName, latitude, longitude, locationInfo);

        // Emit via Socket.IO
        try {
            if (socketService.isInitialized()) {
                socketService.emitToVehicle(vehicleId, 'geofence_alert', {
                    type: 'geofence_violation',
                    title: '⚠️ Geofence Violation',
                    message: `${vehicleName} is OUTSIDE your defined geofence area`,
                    vehicleId: vehicleId,
                    vehicleName: vehicleName,
                    latitude: latitude,
                    longitude: longitude,
                    locationName: locationInfo.locality,
                    formattedAddress: locationInfo.formattedAddress,
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Socket.IO geofence alert emitted to vehicle ${vehicleId}`);
            }
        } catch (socketError) {
            console.error(`⚠️ Socket.IO emit failed:`, socketError.message);
        }

        return {
            violation: true,
            vehicleName,
            latitude,
            longitude,
            locationName: locationInfo.locality,
            userId,
            alertsSent: true,
            isFirstAlert: true
        };

    } catch (error) {
        console.error(`❌ Error checking geofence violation:`, error);
        console.error(`❌ Stack trace:`, error.stack);
        return { violation: false, reason: 'Error occurred', error: error.message };
    }
};

/**
 * Create an alert record in the database
 */
const createGeofenceAlert = async (vehicleId, vehicleName, latitude, longitude, locationInfo, notificationSent) => {
    try {
        const message = `${vehicleName} is OUTSIDE your defined geofence area near ${locationInfo.locality}`;

        await Alert.create({
            voiture_id: vehicleId,
            alert_type: 'geofence',
            message: message,
            latitude: latitude,
            longitude: longitude,
            alert_status: 'ACTIVE',
            alerted_at: new Date(),
            sent: notificationSent,
            read: false
        });

        console.log(`✅ ✅ ✅ Geofence alert created for vehicle ${vehicleId} at ${locationInfo.locality}`);
    } catch (error) {
        console.error(`❌ Error creating geofence alert:`, error);
    }
};

/**
 * Send push notification via Firebase Cloud Messaging
 */
const sendGeofencePushNotification = async (userId, vehicleId, vehicleName, latitude, longitude, locationInfo) => {
    try {
        console.log(`📤 Sending geofence FCM notification to user ${userId}`);

        const title = '⚠️ Geofence Violation';
        const body = `${vehicleName} is OUTSIDE your defined geofence area near ${locationInfo.locality}`;

        await notificationController.sendToUser(userId, {
            title: title,
            body: body,
            data: {
                type: 'geofence_violation',
                vehicleId: String(vehicleId),
                vehicleName: vehicleName,
                latitude: String(latitude),
                longitude: String(longitude),
                locationName: locationInfo.locality,
                formattedAddress: locationInfo.formattedAddress,
                timestamp: new Date().toISOString()
            }
        });

        console.log(`✅ Geofence FCM notification sent for vehicle ${vehicleId}`);

    } catch (error) {
        console.error(`❌ Error sending geofence FCM notification:`, error);
    }
};

/**
 * API endpoint to manually check geofence status
 */
const getGeofenceStatus = async (req, res) => {
    const { vehicleId } = req.params;

    try {
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone FROM voitures WHERE id = ?',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voiture) {
            return res.status(404).json({ error: 'Vehicle not found' });
        }

        const [latestLocation] = await sequelize.query(
            'SELECT latitude, longitude FROM locations WHERE mac_id_gps = ? ORDER BY datetime DESC LIMIT 1',
            {
                replacements: [voiture.mac_id_gps],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!latestLocation) {
            return res.status(404).json({ error: 'No location data available' });
        }

        const result = await checkGeofenceViolation(
            vehicleId,
            latestLocation.latitude,
            latestLocation.longitude
        );

        res.json({
            success: true,
            vehicleId: vehicleId,
            currentLocation: {
                latitude: latestLocation.latitude,
                longitude: latestLocation.longitude
            },
            geofenceStatus: result
        });

    } catch (error) {
        console.error('❌ Error getting geofence status:', error);
        res.status(500).json({ error: 'Server error', details: error.message });
    }
};

module.exports = {
    checkGeofenceViolation,
    getGeofenceStatus
};
