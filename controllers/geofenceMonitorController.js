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
const GEOFENCE_ALERT_COOLDOWN_MINUTES = 30;

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
 * ✅ UPDATED: Format location name - Better fallback handling
 */
const formatLocationName = (locationInfo) => {
    const { route, sublocality, locality, neighborhood, administrativeArea } = locationInfo;

    // Priority 1: route + sublocality
    if (route && sublocality) {
        return `${route}, ${sublocality}`;
    }

    // Priority 2: route only
    if (route) {
        return route;
    }

    // Priority 3: sublocality only
    if (sublocality) {
        return sublocality;
    }

    // Priority 4: neighborhood
    if (neighborhood) {
        return neighborhood;
    }

    // Priority 5: locality (city/town)
    if (locality) {
        return locality;
    }

    // Priority 6: administrative area
    if (administrativeArea) {
        return administrativeArea;
    }

    // Last fallback: areaName or "Unknown Location"
    return locationInfo.areaName || 'Unknown Location';
};

/**
 * ✅ UPDATED: Reverse geocode with better error handling and logging
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

        console.log(`📡 Geocoding API Status: ${response.data.status}`);

        if (response.data.status === 'OK' && response.data.results.length > 0) {
            const result = response.data.results[0];
            const formattedAddress = result.formatted_address;

            // Extract detailed location components
            let neighborhood = null;
            let locality = null;
            let sublocality = null;
            let route = null;
            let administrativeArea = null;
            let country = null;

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
                } else if (component.types.includes('country')) {
                    country = component.long_name;
                }
            }

            // Build areaName with better fallback logic
            const areaName = neighborhood || route || sublocality || locality || administrativeArea || country || formattedAddress.split(',')[0] || 'Unknown Location';

            console.log(`✅ Geocoded successfully!`);
            console.log(`   Route/Street: ${route || 'N/A'}`);
            console.log(`   Sublocality: ${sublocality || 'N/A'}`);
            console.log(`   Neighborhood: ${neighborhood || 'N/A'}`);
            console.log(`   Locality: ${locality || 'N/A'}`);
            console.log(`   Administrative Area: ${administrativeArea || 'N/A'}`);
            console.log(`   Country: ${country || 'N/A'}`);
            console.log(`   Full Address: ${formattedAddress}`);

            return {
                formattedAddress: formattedAddress,
                areaName: areaName,
                locality: locality || administrativeArea || areaName,
                neighborhood: neighborhood,
                route: route,
                sublocality: sublocality,
                administrativeArea: administrativeArea,
                country: country,
                success: true
            };
        } else if (response.data.status === 'ZERO_RESULTS') {
            console.warn(`⚠️ Geocoding returned ZERO_RESULTS - location may be in ocean/remote area`);
            return {
                formattedAddress: 'Unknown Location',
                areaName: 'Unknown Location',
                locality: 'Unknown Location',
                success: false,
                errorReason: 'ZERO_RESULTS'
            };
        } else if (response.data.status === 'OVER_QUERY_LIMIT') {
            console.error(`❌ Google Maps API quota exceeded!`);
            return {
                formattedAddress: 'Location unavailable (API limit)',
                areaName: 'Location unavailable',
                locality: 'Location unavailable',
                success: false,
                errorReason: 'OVER_QUERY_LIMIT'
            };
        } else if (response.data.status === 'REQUEST_DENIED') {
            console.error(`❌ Google Maps API request denied - check API key!`);
            return {
                formattedAddress: 'Location unavailable (API error)',
                areaName: 'Location unavailable',
                locality: 'Location unavailable',
                success: false,
                errorReason: 'REQUEST_DENIED'
            };
        } else {
            console.warn(`⚠️ Geocoding failed: ${response.data.status}`);
            console.warn(`   Error message: ${response.data.error_message || 'No error message'}`);
            return {
                formattedAddress: 'Unknown Location',
                areaName: 'Unknown Location',
                locality: 'Unknown Location',
                success: false,
                errorReason: response.data.status
            };
        }
    } catch (error) {
        console.error(`❌ Geocoding error:`, error.message);

        // Check if it's a timeout
        if (error.code === 'ECONNABORTED') {
            console.error(`   Reason: Request timeout`);
        }

        // Check if it's a network error
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            console.error(`   Reason: Network error - cannot reach Google Maps API`);
        }

        return {
            formattedAddress: 'Unknown Location',
            areaName: 'Unknown Location',
            locality: 'Unknown Location',
            success: false,
            errorReason: error.message
        };
    }
};

/**
 * ✅ NEW: Get current geofence state from vehicle_security
 */
const getCurrentGeofenceState = async (vehicleId) => {
    try {
        const [security] = await sequelize.query(
            `SELECT last_geofence_state, last_state_change_at
             FROM vehicle_security
             WHERE voiture_id = ?
                 LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (security) {
            return {
                currentState: security.last_geofence_state || 'inside',
                lastStateChangeAt: security.last_state_change_at ? new Date(security.last_state_change_at) : null
            };
        }

        return {
            currentState: 'inside',
            lastStateChangeAt: null
        };
    } catch (error) {
        console.error('🔥 Error getting current geofence state:', error);
        return {
            currentState: 'inside',
            lastStateChangeAt: null
        };
    }
};

/**
 * ✅ NEW: Update geofence state in vehicle_security
 */
const updateGeofenceState = async (vehicleId, newState, crossingTime) => {
    try {
        await sequelize.query(
            `UPDATE vehicle_security
             SET last_geofence_state = ?,
                 last_state_change_at = ?
             WHERE voiture_id = ?`,
            {
                replacements: [newState, crossingTime, vehicleId],
                type: sequelize.QueryTypes.UPDATE
            }
        );

        console.log(`✅ Updated geofence state: ${newState} at ${crossingTime}`);
        return true;
    } catch (error) {
        console.error('🔥 Error updating geofence state:', error);
        return false;
    }
};

/**
 * ✅ NEW: Get active geofence alert (LEFT_ZONE that hasn't been resolved)
 */
const getActiveGeofenceAlert = async (vehicleId) => {
    try {
        const [alert] = await sequelize.query(
            `SELECT id, alerted_at, alert_subtype, alert_status
             FROM alerts
             WHERE voiture_id = ?
               AND alert_type = 'geofence'
               AND alert_subtype = 'LEFT_ZONE'
               AND alert_status = 'ACTIVE'
             ORDER BY alerted_at DESC
                 LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        return alert || null;
    } catch (error) {
        console.error('🔥 Error getting active geofence alert:', error);
        return null;
    }
};

/**
 * ✅ NEW: Mark alert as resolved
 */
const resolveAlert = async (alertId) => {
    try {
        await sequelize.query(
            `UPDATE alerts
             SET alert_status = 'RESOLVED'
             WHERE id = ?`,
            {
                replacements: [alertId],
                type: sequelize.QueryTypes.UPDATE
            }
        );

        console.log(`✅ Alert ${alertId} marked as RESOLVED`);
        return true;
    } catch (error) {
        console.error('🔥 Error resolving alert:', error);
        return false;
    }
};

/**
 * ✅ NEW: Format time string from minutes
 */
const formatTimeAgo = (minutes) => {
    if (minutes === 0) {
        return 'just now';
    } else if (minutes === 1) {
        return '1 minute ago';
    } else {
        return `${minutes} minutes ago`;
    }
};

/**
 * ✅ NEW: Initialize geofence state when geofence is created/enabled
 * This handles the case where vehicle is already outside when geofence is set up
 */
const initializeGeofenceState = async (vehicleId) => {
    try {
        console.log(`\n========================================`);
        console.log(`🎯 INITIALIZING GEOFENCE STATE`);
        console.log(`========================================`);
        console.log(`🚗 Vehicle ID: ${vehicleId}`);

        // Get vehicle data
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voiture || !voiture.geofence_zone) {
            console.log(`⚠️ No geofence defined for vehicle ${vehicleId}`);
            console.log(`========================================\n`);
            return { success: false, reason: 'No geofence defined' };
        }

        // Get latest GPS location
        const [location] = await sequelize.query(
            'SELECT latitude, longitude, datetime FROM locations WHERE mac_id_gps = ? ORDER BY datetime DESC LIMIT 1',
            {
                replacements: [voiture.mac_id_gps],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!location) {
            console.log(`⚠️ No GPS data available for vehicle ${vehicleId}`);
            console.log(`========================================\n`);
            return { success: false, reason: 'No GPS data' };
        }

        console.log(`📍 Current location: [${location.latitude}, ${location.longitude}]`);

        // Parse geofence
        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone)
                : voiture.geofence_zone;
        } catch (error) {
            console.log(`❌ Invalid geofence data`);
            console.log(`========================================\n`);
            return { success: false, reason: 'Invalid geofence data' };
        }

        // Check if vehicle is inside or outside
        const isInside = isInsideGeofence(location.latitude, location.longitude, geofenceZone);
        const initialState = isInside ? 'inside' : 'outside';

        console.log(`🎯 Vehicle is currently: ${isInside ? '🟢 INSIDE' : '🔴 OUTSIDE'}`);
        console.log(`📊 Setting initial state to: ${initialState}`);

        // Update vehicle_security with initial state
        await sequelize.query(
            `UPDATE vehicle_security
             SET last_geofence_state = ?,
                 last_state_change_at = NOW()
             WHERE voiture_id = ?`,
            {
                replacements: [initialState, vehicleId],
                type: sequelize.QueryTypes.UPDATE
            }
        );

        console.log(`✅ Geofence state initialized successfully`);
        console.log(`========================================\n`);

        return {
            success: true,
            vehicleId,
            initialState,
            isInside,
            latitude: location.latitude,
            longitude: location.longitude
        };

    } catch (error) {
        console.error(`❌ Error initializing geofence state:`, error);
        console.log(`========================================\n`);
        return { success: false, reason: 'Error occurred', error: error.message };
    }
};

/**
 * ✅ ENHANCED: Check geofence with state tracking
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

        console.log(`✅ Vehicle found: ${voiture.nickname || `${voiture.marque} ${voiture.model}`}`);

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
        const currentState = isInside ? 'inside' : 'outside';

        console.log(`🎯 Vehicle is: ${isInside ? '🟢 INSIDE' : '🔴 OUTSIDE'} geofence`);

        // ✅ STEP 6: Get previous state
        console.log(`\n🔍 STEP 6: Getting previous state...`);
        let stateInfo = await getCurrentGeofenceState(vehicleId);
        let previousState = stateInfo.currentState;
        let lastStateChangeAt = stateInfo.lastStateChangeAt;

        // ✅ AUTO-INITIALIZE: If state has never been set, initialize it now
        if (!lastStateChangeAt) {
            console.log(`\n🎯 FIRST GEOFENCE CHECK - Auto-initializing state...`);
            const initResult = await initializeGeofenceState(vehicleId);

            if (initResult.success) {
                // Reload state after initialization
                stateInfo = await getCurrentGeofenceState(vehicleId);
                previousState = stateInfo.currentState;
                lastStateChangeAt = stateInfo.lastStateChangeAt;

                console.log(`✅ State auto-initialized: ${previousState}`);
            } else {
                console.warn(`⚠️ Auto-initialization failed, using default state`);
            }
        }

        console.log(`📊 Previous state: ${previousState}`);
        console.log(`📅 Last state change: ${lastStateChangeAt ? lastStateChangeAt.toISOString() : 'Never'}`);

        // ✅ STEP 7: Detect state changes
        console.log(`\n🔍 STEP 7: Detecting state changes...`);
        const stateChanged = previousState !== currentState;

        if (!stateChanged) {
            console.log(`ℹ️ No state change - vehicle still ${currentState}`);
            console.log(`========================================\n`);
            return { violation: false, reason: 'No state change' };
        }

        // ✅ STATE CHANGED!
        console.log(`\n========================================`);
        console.log(`🎯 STATE CHANGE DETECTED!`);
        console.log(`========================================`);
        console.log(`📊 Previous: ${previousState} → Current: ${currentState}`);

        const crossingTime = new Date();

        // ✅ Update state in database
        await updateGeofenceState(vehicleId, currentState, crossingTime);

        // ✅ Handle alerts based on state change
        if (currentState === 'outside') {
            // ✅ Vehicle LEFT the zone
            console.log(`🚨 Vehicle LEFT the geofence`);

            // Check if there's already an active LEFT_ZONE alert
            const existingAlert = await getActiveGeofenceAlert(vehicleId);

            if (existingAlert) {
                console.log(`⚠️ Active LEFT_ZONE alert already exists (ID: ${existingAlert.id}). Skipping alert creation.`);
            } else {
                // Create new LEFT_ZONE alert
                await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'LEFT_ZONE', crossingTime, true);
            }
        } else {
            // ✅ Vehicle RETURNED to the zone
            console.log(`✅ Vehicle RETURNED to the geofence`);

            // Find and resolve the active LEFT_ZONE alert
            const activeAlert = await getActiveGeofenceAlert(vehicleId);

            if (activeAlert) {
                console.log(`🔄 Resolving previous LEFT_ZONE alert (ID: ${activeAlert.id})`);
                await resolveAlert(activeAlert.id);
            }

            // Create RETURNED_ZONE alert
            await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'RETURNED_ZONE', crossingTime, true);
        }

        console.log(`\n========================================`);
        console.log(`✅ GEOFENCE STATE CHANGE COMPLETE`);
        console.log(`========================================\n`);

        return {
            violation: currentState === 'outside',
            stateChanged: true,
            previousState,
            currentState,
            alertSubtype: currentState === 'outside' ? 'LEFT_ZONE' : 'RETURNED_ZONE',
            crossingTime: crossingTime.toISOString()
        };

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
 * ✅ UPDATED: Create geofence alert (simplified - no STILL_OUTSIDE alerts)
 */
const createGeofenceAlert = async (vehicleId, voiture, latitude, longitude, alertSubtype, crossingTime, shouldSendPushNotification) => {
    try {
        console.log(`\n📝 Creating ${alertSubtype} alert...`);

        // Get vehicle owner
        const [vehicleOwner] = await sequelize.query(
            `SELECT user_id FROM association_user_voitures WHERE voiture_id = ? LIMIT 1`,
            {
                replacements: [vehicleId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!vehicleOwner || !vehicleOwner.user_id) {
            console.warn(`⚠️ No owner found for vehicle ${vehicleId}`);
            return;
        }

        const userId = vehicleOwner.user_id;

        // Get user alert settings
        const alertSettings = await getUserAlertSettings(userId);

        // Get location name
        const locationInfo = await reverseGeocode(latitude, longitude);
        const locationName = formatLocationName(locationInfo);

        console.log(`📍 Location: ${locationName}`);

        const vehicleName = voiture.nickname || `${voiture.marque} ${voiture.model}`;

        // Calculate time since crossing
        const minutesSinceCrossing = Math.round((Date.now() - new Date(crossingTime).getTime()) / (1000 * 60));
        const timeText = formatTimeAgo(minutesSinceCrossing);

        // Create message based on alert type
        let alertMessage;
        let notificationTitle;

        if (alertSubtype === 'LEFT_ZONE') {
            alertMessage = `Your vehicle ${vehicleName} left the defined zone ${timeText} via ${locationName}`;
            notificationTitle = '⚠️ Geofence Alert';
        } else {
            // RETURNED_ZONE
            alertMessage = `Your vehicle ${vehicleName} returned to the defined zone ${timeText} via ${locationName}`;
            notificationTitle = '✅ Vehicle Returned';
        }

        console.log(`📝 Alert Message: "${alertMessage}"`);

        // Create alert in database
        const newAlert = await Alert.create({
            voiture_id: vehicleId,
            alert_type: 'geofence',
            alert_subtype: alertSubtype,
            message: alertMessage,
            latitude: latitude,
            longitude: longitude,
            alert_status: 'ACTIVE',
            alerted_at: crossingTime,
            sent: alertSettings.geofenceAlertsEnabled && shouldSendPushNotification,
            read: false
        });

        console.log(`✅ Alert created in database (ID: ${newAlert.id})`);

        // Send push notification
        if (shouldSendPushNotification && alertSettings.geofenceAlertsEnabled) {
            console.log(`\n📲 Sending push notification...`);

            try {
                const notificationResult = await notificationController.sendToUser(userId, {
                    title: notificationTitle,
                    body: alertMessage,
                    data: {
                        type: alertSubtype === 'LEFT_ZONE' ? 'geofence_violation' : 'geofence_return',
                        alertSubtype: alertSubtype,
                        vehicleId: String(vehicleId),
                        vehicleName: vehicleName,
                        latitude: String(latitude),
                        longitude: String(longitude),
                        locationName: locationName,
                        formattedAddress: locationInfo.formattedAddress,
                        crossingTime: crossingTime.toISOString(),
                        timestamp: new Date().toISOString()
                    }
                });

                if (notificationResult.success) {
                    console.log(`✅ Push notification sent (${notificationResult.successCount} devices)`);
                } else {
                    console.log(`⚠️ Push notification failed: ${notificationResult.message}`);
                }
            } catch (notifError) {
                console.error(`❌ Push notification error:`, notifError.message);
            }
        } else {
            console.log(`🔕 Push notification skipped (enabled: ${alertSettings.geofenceAlertsEnabled})`);
        }

        // Emit Socket.IO notification
        try {
            if (socketService.isInitialized()) {
                socketService.emitToVehicle(vehicleId, 'geofence_alert', {
                    alertId: newAlert.id,
                    type: alertSubtype,
                    severity: alertSubtype === 'LEFT_ZONE' ? 'warning' : 'info',
                    title: notificationTitle,
                    message: alertMessage,
                    vehicleId: vehicleId,
                    vehicleName: vehicleName,
                    latitude: latitude,
                    longitude: longitude,
                    locationName: locationName,
                    formattedAddress: locationInfo.formattedAddress,
                    crossingTime: crossingTime.toISOString(),
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Socket.IO notification emitted`);
            }
        } catch (socketError) {
            console.error(`❌ Socket.IO error:`, socketError.message);
        }

        return newAlert;

    } catch (error) {
        console.error(`❌ Error creating geofence alert:`, error);
        throw error;
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

/**
 * ✅ API endpoint to initialize geofence state
 * Call this after creating/updating a geofence
 */
const initializeGeofenceStateEndpoint = async (req, res) => {
    const { vehicleId } = req.params;

    try {
        console.log(`📥 Received request to initialize geofence state for vehicle ${vehicleId}`);

        const result = await initializeGeofenceState(vehicleId);

        if (result.success) {
            res.json({
                success: true,
                message: 'Geofence state initialized successfully',
                data: result
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.reason || 'Failed to initialize geofence state',
                data: result
            });
        }
    } catch (error) {
        console.error('❌ Error in initializeGeofenceStateEndpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

module.exports = {
    checkGeofenceViolation,
    getGeofenceStatus,
    initializeGeofenceState,
    initializeGeofenceStateEndpoint
};