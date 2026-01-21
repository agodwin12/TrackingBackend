// controllers/geofenceMonitorController.js

const VehicleSecurity = require('../models/vehicleSecurity');
const Alert = require('../models/Alert');
const notificationController = require('./notificationController');
const sequelize = require('../config/database');
const { isInsideGeofence } = require('../services/geofenceService');
const socketService = require('../services/socketService');
const axios = require('axios');
const moment = require('moment');

// Google Maps API key for geocoding
const GOOGLE_MAPS_API_KEY = 'AIzaSyBn88TP5X-xaRCYo5gYxvGnVy_0WYotZWo';

// ✅ Cooldown period for geofence alerts (in minutes)
const GEOFENCE_ALERT_COOLDOWN_MINUTES = 30;

/**
 * ✅ Format time ago string
 */
const getTimeAgo = (date) => {
    return moment(date).fromNow();
};

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
                geofenceAlertsEnabled: user.geofence_alerts_enabled !== false,
                safeZoneAlertsEnabled: user.safe_zone_alerts_enabled !== false,
            };

            console.log(`✅ Alert settings retrieved for user ${userId}:`, settings);
            return settings;
        }

        console.warn(`⚠️ User ${userId} not found, using default settings`);
        return {
            geofenceAlertsEnabled: true,
            safeZoneAlertsEnabled: true,
        };
    } catch (error) {
        console.error(`❌ Error fetching user alert settings for user ${userId}:`, error);
        return {
            geofenceAlertsEnabled: true,
            safeZoneAlertsEnabled: true,
        };
    }
};

/**
 * ✅ Reverse geocode coordinates to get detailed location name
 */
const reverseGeocode = async (latitude, longitude) => {
    try {
        console.log(`📍 Reverse geocoding: [${latitude}, ${longitude}]`);

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

            // Extract detailed location components
            let neighborhood = null;  // Quartier
            let locality = null;       // City
            let sublocality = null;    // Sub-city area
            let route = null;          // Street/Road name
            let administrativeArea = null;

            for (const component of result.address_components) {
                if (component.types.includes('neighborhood')) {
                    neighborhood = component.long_name;
                } else if (component.types.includes('route')) {
                    route = component.long_name;
                } else if (component.types.includes('sublocality') || component.types.includes('sublocality_level_1')) {
                    sublocality = component.long_name;
                } else if (component.types.includes('locality')) {
                    locality = component.long_name;
                } else if (component.types.includes('administrative_area_level_2')) {
                    if (!locality) administrativeArea = component.long_name;
                } else if (component.types.includes('administrative_area_level_1')) {
                    if (!locality && !administrativeArea) administrativeArea = component.long_name;
                }
            }

            // Prioritize: neighborhood > route > sublocality > locality > administrative area
            const areaName = neighborhood || route || sublocality || locality || administrativeArea || formattedAddress.split(',')[0];

            console.log(`✅ Geocoded successfully!`);
            console.log(`   Neighborhood: ${neighborhood || 'N/A'}`);
            console.log(`   Route/Road: ${route || 'N/A'}`);
            console.log(`   Sublocality: ${sublocality || 'N/A'}`);
            console.log(`   Locality: ${locality || 'N/A'}`);
            console.log(`   Selected Area: ${areaName}`);
            console.log(`   Full Address: ${formattedAddress}`);

            return {
                formattedAddress: formattedAddress,
                areaName: areaName,  // This is the "quartier" or neighborhood or road
                locality: locality || areaName,
                neighborhood: neighborhood,
                route: route,
                sublocality: sublocality,
                success: true
            };
        } else {
            console.warn(`⚠️ Geocoding failed: ${response.data.status}`);
            return {
                formattedAddress: `${latitude}, ${longitude}`,
                areaName: `${latitude}, ${longitude}`,
                locality: `${latitude}, ${longitude}`,
                success: false
            };
        }
    } catch (error) {
        console.error(`❌ Geocoding error:`, error.message);
        return {
            formattedAddress: `${latitude}, ${longitude}`,
            areaName: `${latitude}, ${longitude}`,
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
 * Check if vehicle has left its geofence zone - WITH ENHANCED LOGGING
 */
const checkGeofenceViolation = async (vehicleId, latitude, longitude) => {
    console.log(`\n========================================`);
    console.log(`🚨 GEOFENCE CHECK STARTED`);
    console.log(`========================================`);
    console.log(`🚗 Vehicle ID: ${vehicleId}`);
    console.log(`📍 Current Position: [${latitude}, ${longitude}]`);

    try {
        // ✅ STEP 1: Fetch vehicle data
        console.log(`\n🔍 STEP 1: Fetching vehicle from database...`);
        const [voiture] = await sequelize.query(
            'SELECT id, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voiture) {
            console.warn(`⚠️ Vehicle ${vehicleId} not found`);
            console.log(`========================================\n`);
            return { violation: false, reason: 'Vehicle not found' };
        }

        console.log(`✅ Vehicle found!`);
        console.log(`   Name: ${voiture.nickname || `${voiture.marque} ${voiture.model}`}`);

        // ✅ STEP 2: Check if geofencing is active
        console.log(`\n🔍 STEP 2: Checking if geofencing is active...`);
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!security || !security.is_active) {
            console.log(`ℹ️ Geofencing not active for vehicle ${vehicleId}`);
            console.log(`========================================\n`);
            return { violation: false, reason: 'Geofencing not active' };
        }

        console.log(`✅ Geofencing is ACTIVE`);

        // ✅ STEP 3: Check if geofence zone is defined
        console.log(`\n🔍 STEP 3: Checking geofence zone...`);
        if (!voiture.geofence_zone) {
            console.warn(`⚠️ No geofence zone defined`);
            console.log(`========================================\n`);
            return { violation: false, reason: 'No geofence defined' };
        }

        console.log(`✅ Geofence zone found`);

        // ✅ STEP 4: Parse geofence zone
        console.log(`\n🔍 STEP 4: Parsing geofence zone...`);
        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone)
                : voiture.geofence_zone;

            console.log(`✅ Geofence zone parsed: ${geofenceZone.length} points`);
        } catch (parseError) {
            console.error(`❌ Error parsing geofence zone:`, parseError);
            console.log(`========================================\n`);
            return { violation: false, reason: 'Invalid geofence data' };
        }

        // ✅ STEP 5: Check if vehicle is inside/outside
        console.log(`\n🔍 STEP 5: Checking vehicle position...`);
        const isInside = isInsideGeofence(latitude, longitude, geofenceZone);

        console.log(`🎯 Vehicle is: ${isInside ? '🟢 INSIDE' : '🔴 OUTSIDE'} geofence`);

        // ✅ SCENARIO 1: Vehicle is INSIDE - no violation
        if (isInside) {
            console.log(`ℹ️ Vehicle inside geofence - no alert needed`);
            console.log(`========================================\n`);
            return { violation: false, reason: 'Vehicle inside geofence' };
        }

        // ✅ SCENARIO 2: Vehicle is OUTSIDE - check cooldown
        console.log(`\n========================================`);
        console.log(`🚨 GEOFENCE VIOLATION DETECTED!`);
        console.log(`========================================`);
        console.log(`Vehicle ${vehicleId} is OUTSIDE the geofence!`);

        console.log(`\n🔍 STEP 6: Checking cooldown...`);
        const lastAlert = await getLastGeofenceAlert(vehicleId);

        if (lastAlert) {
            const minutesSinceLastAlert = (Date.now() - new Date(lastAlert.alerted_at).getTime()) / (1000 * 60);
            console.log(`📅 Last alert: ${Math.round(minutesSinceLastAlert)} minutes ago`);
            console.log(`⏰ Cooldown period: ${GEOFENCE_ALERT_COOLDOWN_MINUTES} minutes`);

            if (minutesSinceLastAlert < GEOFENCE_ALERT_COOLDOWN_MINUTES) {
                const remaining = Math.round(GEOFENCE_ALERT_COOLDOWN_MINUTES - minutesSinceLastAlert);
                console.log(`⏳ Cooldown active - ${remaining} minutes remaining`);
                console.log(`========================================\n`);
                return {
                    violation: true,
                    reason: 'Cooldown active',
                    isFirstAlert: false
                };
            }
            console.log('✅ Cooldown expired - creating new alert');
        } else {
            console.log('✅ No previous alert - creating first alert');
        }

        // ✅ STEP 7: Get vehicle owner
        console.log(`\n🔍 STEP 7: Finding vehicle owner...`);
        const [vehicleOwner] = await sequelize.query(
            `SELECT user_id FROM association_user_voitures WHERE voiture_id = ? LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!vehicleOwner || !vehicleOwner.user_id) {
            console.warn(`⚠️ No owner found`);
            console.log(`========================================\n`);
            return { violation: true, reason: 'No owner found' };
        }

        const userId = vehicleOwner.user_id;
        console.log(`✅ Owner found: User ${userId}`);

        // ✅ STEP 8: Check if alerts are enabled
        console.log(`\n🔍 STEP 8: Checking alert settings...`);
        const alertSettings = await getUserAlertSettings(userId);

        // ✅ STEP 9: Get location name (area where vehicle crossed)
        console.log(`\n🔍 STEP 9: Getting location name...`);
        const locationInfo = await reverseGeocode(latitude, longitude);
        console.log(`✅ Area: ${locationInfo.areaName}`);
        console.log(`✅ Full Address: ${locationInfo.formattedAddress}`);

        const vehicleName = voiture.nickname || `${voiture.marque} ${voiture.model}`;

        // ✅ Get time ago
        const timeAgo = getTimeAgo(new Date());

        // ✅ Create alert message in the new format
        // "Your vehicle TINBOT left the geofence just now from Bastos"
        const alertMessage = `Your vehicle ${vehicleName} left the geofence ${timeAgo} from ${locationInfo.areaName}`;

        console.log(`\n📝 Alert Message: "${alertMessage}"`);

        // ✅ STEP 10: Create alert in database
        console.log(`\n🔍 STEP 10: Creating alert in database...`);

        try {
            const newAlert = await Alert.create({
                voiture_id: vehicleId,
                alert_type: 'geofence',
                message: alertMessage,
                latitude: latitude,
                longitude: longitude,
                alert_status: 'ACTIVE',
                alerted_at: new Date(),
                sent: alertSettings.geofenceAlertsEnabled ? true : false,
                read: false
            });

            console.log(`✅ GEOFENCE ALERT CREATED IN DATABASE!`);
            console.log(`   Alert ID: ${newAlert.id}`);
            console.log(`   Vehicle ID: ${newAlert.voiture_id}`);
            console.log(`   Type: ${newAlert.alert_type}`);
            console.log(`   Message: ${newAlert.message}`);
            console.log(`   Location: [${newAlert.latitude}, ${newAlert.longitude}]`);
            console.log(`   Area Name: ${locationInfo.areaName}`);
            console.log(`   Full Address: ${locationInfo.formattedAddress}`);
            console.log(`   Created At: ${newAlert.alerted_at}`);
            console.log(`   Sent: ${newAlert.sent}`);

            // ✅ STEP 11: Send push notification (if enabled)
            if (!alertSettings.geofenceAlertsEnabled) {
                console.log(`🔕 Geofence alerts DISABLED for user ${userId}`);
                console.log(`ℹ️ Alert saved in database but NO notification sent`);
            } else {
                console.log(`\n🔍 STEP 11: Sending push notification...`);
                console.log(`   User ID: ${userId}`);
                console.log(`   Vehicle Name: ${vehicleName}`);
                console.log(`   Area: ${locationInfo.areaName}`);

                try {
                    const notificationResult = await notificationController.sendToUser(userId, {
                        title: '⚠️ Geofence Violation',
                        body: alertMessage,
                        data: {
                            type: 'geofence_violation',
                            vehicleId: String(vehicleId),
                            vehicleName: vehicleName,
                            latitude: String(latitude),
                            longitude: String(longitude),
                            areaName: locationInfo.areaName,
                            locationName: locationInfo.locality,
                            formattedAddress: locationInfo.formattedAddress,
                            timestamp: new Date().toISOString()
                        }
                    });

                    if (notificationResult.success) {
                        console.log(`✅ GEOFENCE PUSH NOTIFICATION SENT SUCCESSFULLY!`);
                        console.log(`   Success Count: ${notificationResult.successCount}`);
                        console.log(`   Failure Count: ${notificationResult.failureCount}`);
                    } else {
                        console.log(`⚠️ Push notification failed: ${notificationResult.message}`);
                    }
                } catch (notifError) {
                    console.error(`❌ PUSH NOTIFICATION ERROR:`, notifError.message);
                    console.error(`Stack trace:`, notifError.stack);
                }
            }

            // ✅ STEP 12: Emit Socket.IO notification
            console.log(`\n🔍 STEP 12: Emitting Socket.IO notification...`);
            try {
                if (socketService.isInitialized()) {
                    socketService.emitToVehicle(vehicleId, 'geofence_alert', {
                        alertId: newAlert.id,
                        type: 'geofence_violation',
                        severity: 'warning',
                        title: '⚠️ Geofence Violation',
                        message: alertMessage,
                        vehicleId: vehicleId,
                        vehicleName: vehicleName,
                        latitude: latitude,
                        longitude: longitude,
                        areaName: locationInfo.areaName,
                        locationName: locationInfo.locality,
                        formattedAddress: locationInfo.formattedAddress,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`✅ Socket.IO notification emitted`);
                }
            } catch (socketError) {
                console.error(`❌ Socket.IO error:`, socketError.message);
            }

            console.log(`\n========================================`);
            console.log(`✅ GEOFENCE VIOLATION ALERT COMPLETE`);
            console.log(`========================================\n`);

            return {
                violation: true,
                vehicleName,
                latitude,
                longitude,
                areaName: locationInfo.areaName,
                locationName: locationInfo.locality,
                formattedAddress: locationInfo.formattedAddress,
                userId,
                alertsSent: alertSettings.geofenceAlertsEnabled,
                isFirstAlert: true,
                alertId: newAlert.id,
                message: alertMessage
            };

        } catch (alertError) {
            console.error(`\n========================================`);
            console.error(`❌ ERROR CREATING GEOFENCE ALERT IN DATABASE`);
            console.error(`========================================`);
            console.error(`Error message:`, alertError.message);
            console.error(`Stack trace:`, alertError.stack);
            console.error(`========================================\n`);
            throw alertError;
        }

    } catch (error) {
        console.error(`\n========================================`);
        console.error(`❌ GEOFENCE CHECK ERROR`);
        console.error(`========================================`);
        console.error(`Error message:`, error.message);
        console.error(`Stack trace:`, error.stack);
        console.error(`========================================\n`);
        return { violation: false, reason: 'Error occurred', error: error.message };
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
                replacements: [vehicleId],
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