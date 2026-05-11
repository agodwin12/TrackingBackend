
const Alert           = require('../models/Alert');
const notificationController = require('./notificationController');
const sequelize       = require('../config/database');
const { isInsideGeofence } = require('../services/geofenceService');
const socketService   = require('../services/socketService');
const axios           = require('axios');
const { hasFeature, FEATURES } = require('../services/hasFeature');
const logger          = require('../utils/logger');
const redisClient = require('../config/redis');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ── tuneable constants ────────────────────────────────────────────────────────
// Maximum plausible ground speed (km/h). Anything above this is a GPS spike.
// 200 km/h is already very generous for Cameroon moto/car fleet.
const MAX_PLAUSIBLE_SPEED_KMH = 200;

// How many consecutive outside readings required before firing LEFT_ZONE alert.
// 3 = need three back-to-back bad readings → covers the 2-minute Nsimalen incident.
const OUTSIDE_CONFIRM_THRESHOLD = 3;
// ─────────────────────────────────────────────────────────────────────────────

// ── haversine distance (km) ───────────────────────────────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ── velocity / plausibility filter ───────────────────────────────────────────
/**
 * Returns true if the new coordinate is plausible given recent history.
 * Returns false if the implied speed vs the previous reading exceeds
 * MAX_PLAUSIBLE_SPEED_KMH (i.e. the device teleported).
 */
const isCoordinatePlausible = async (macIdGps, newLat, newLng) => {
    try {
        let prevLat, prevLng, prevTime;

        // Redis first — written by location.js on every GPS cycle, O(1)
        const cached = await redisClient.get(`gps:last:${macIdGps}`);
        if (cached) {
            const p = JSON.parse(cached);
            prevLat  = parseFloat(p.latitude);
            prevLng  = parseFloat(p.longitude);
            prevTime = new Date(p.sys_time);
            logger.debug(`🛡️ [VelocityFilter] Redis HIT mac=${macIdGps}`);
        } else {
            // DB fallback — only on cold start or after Redis restart
            logger.debug(`🛡️ [VelocityFilter] Redis MISS mac=${macIdGps} — querying DB`);
            const rows = await sequelize.query(
                `SELECT latitude, longitude, sys_time
                 FROM   locations
                 WHERE  mac_id_gps = :mac
                   AND  latitude  != 0
                   AND  longitude != 0
                 ORDER  BY sys_time DESC
                 LIMIT  1`,
                { replacements: { mac: macIdGps }, type: sequelize.QueryTypes.SELECT }
            );
            if (!rows || rows.length === 0) {
                return { plausible: true, reason: 'no_prior_data' };
            }
            prevLat  = parseFloat(rows[0].latitude);
            prevLng  = parseFloat(rows[0].longitude);
            prevTime = new Date(rows[0].sys_time);
        }

        const distKm          = haversineKm(prevLat, prevLng, newLat, newLng);
        const hoursElapsed    = (Date.now() - prevTime.getTime()) / 3_600_000;
        const impliedSpeedKmh = hoursElapsed > 0
            ? distKm / hoursElapsed
            : distKm > 0.05 ? Infinity : 0;

        logger.debug(
            `🛡️ [VelocityFilter] mac=${macIdGps} dist=${distKm.toFixed(2)}km ` +
            `elapsed=${(hoursElapsed * 60).toFixed(1)}min speed=${impliedSpeedKmh.toFixed(0)}km/h`
        );

        if (impliedSpeedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
            logger.warn(
                `🚨 [VelocityFilter] TELEPORT DETECTED mac=${macIdGps} ` +
                `${distKm.toFixed(1)}km in ${(hoursElapsed * 60).toFixed(1)}min ` +
                `(${impliedSpeedKmh.toFixed(0)}km/h) — coordinate REJECTED`
            );
            return { plausible: false, reason: 'velocity_exceeded', distKm, impliedSpeedKmh };
        }

        return { plausible: true, reason: 'ok', distKm, impliedSpeedKmh };

    } catch (err) {
        logger.error(`❌ [VelocityFilter] error: ${err.message}`);
        return { plausible: true, reason: 'filter_error' };
    }
};

// ── alert settings ────────────────────────────────────────────────────────────
const getUserAlertSettings = async (userId) => {
    try {
        const [user] = await sequelize.query(
            'SELECT geofence_alerts_enabled, safe_zone_alerts_enabled FROM users WHERE id = ? LIMIT 1',
            { replacements: [userId], type: sequelize.QueryTypes.SELECT }
        );
        if (user) {
            return {
                geofenceAlertsEnabled: user.geofence_alerts_enabled !== false,
                safeZoneAlertsEnabled: user.safe_zone_alerts_enabled !== false,
            };
        }
        return { geofenceAlertsEnabled: true, safeZoneAlertsEnabled: true };
    } catch (err) {
        logger.error(`❌ getUserAlertSettings: ${err.message}`);
        return { geofenceAlertsEnabled: true, safeZoneAlertsEnabled: true };
    }
};

// ── geocoding helpers ─────────────────────────────────────────────────────────
const formatLocationName = ({ route, sublocality, locality, neighborhood, administrativeArea, areaName }) => {
    if (route && sublocality) return `${route}, ${sublocality}`;
    if (route)               return route;
    if (sublocality)         return sublocality;
    if (neighborhood)        return neighborhood;
    if (locality)            return locality;
    if (administrativeArea)  return administrativeArea;
    return areaName || 'Unknown Location';
};

const reverseGeocode = async (latitude, longitude) => {
    try {
        const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: { latlng: `${latitude},${longitude}`, key: GOOGLE_MAPS_API_KEY, language: 'en' },
            timeout: 5000
        });

        if (res.data.status === 'OK' && res.data.results.length > 0) {
            const result = res.data.results[0];
            let neighborhood = null, locality = null, sublocality = null;
            let route = null, administrativeArea = null, country = null;

            for (const c of result.address_components) {
                if (c.types.includes('neighborhood'))                               neighborhood = c.long_name;
                else if (c.types.includes('route'))                                 route        = c.long_name;
                else if (c.types.includes('sublocality') || c.types.includes('sublocality_level_1')) sublocality = c.long_name;
                else if (c.types.includes('locality'))                              locality     = c.long_name;
                else if (c.types.includes('administrative_area_level_2') && !locality)             administrativeArea = c.long_name;
                else if (c.types.includes('administrative_area_level_1') && !locality && !administrativeArea) administrativeArea = c.long_name;
                else if (c.types.includes('country'))                               country      = c.long_name;
            }

            const areaName = neighborhood || route || sublocality || locality || administrativeArea || country || result.formatted_address.split(',')[0] || 'Unknown Location';
            return {
                formattedAddress: result.formatted_address, areaName,
                locality: locality || administrativeArea || areaName,
                neighborhood, route, sublocality, administrativeArea, country, success: true
            };
        }

        return { formattedAddress: 'Unknown Location', areaName: 'Unknown Location', locality: 'Unknown Location', success: false };
    } catch (err) {
        logger.error(`❌ reverseGeocode: ${err.message}`);
        return { formattedAddress: 'Unknown Location', areaName: 'Unknown Location', locality: 'Unknown Location', success: false };
    }
};

// ── geofence state helpers ────────────────────────────────────────────────────
const getCurrentGeofenceState = async (vehicleId) => {
    try {
        const [row] = await sequelize.query(
            `SELECT last_geofence_state, last_state_change_at,
                    consecutive_outside_count, last_outside_at
             FROM vehicle_security WHERE voiture_id = ? LIMIT 1`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (row) {
            return {
                currentState:            row.last_geofence_state || 'inside',
                lastStateChangeAt:       row.last_state_change_at ? new Date(row.last_state_change_at) : null,
                consecutiveOutsideCount: parseInt(row.consecutive_outside_count) || 0,
                lastOutsideAt:           row.last_outside_at ? new Date(row.last_outside_at) : null,
            };
        }
        return { currentState: 'inside', lastStateChangeAt: null, consecutiveOutsideCount: 0, lastOutsideAt: null };
    } catch (err) {
        logger.error(`❌ getCurrentGeofenceState: ${err.message}`);
        return { currentState: 'inside', lastStateChangeAt: null, consecutiveOutsideCount: 0, lastOutsideAt: null };
    }
};

const updateGeofenceState = async (vehicleId, newState, crossingTime) => {
    try {
        await sequelize.query(
            `UPDATE vehicle_security
             SET last_geofence_state = ?, last_state_change_at = ?
             WHERE voiture_id = ?`,
            { replacements: [newState, crossingTime, vehicleId], type: sequelize.QueryTypes.UPDATE }
        );
        return true;
    } catch (err) {
        logger.error(`❌ updateGeofenceState: ${err.message}`);
        return false;
    }
};

/**
 * Increment the consecutive-outside counter.
 * Returns the new count so the caller can decide whether to fire the alert.
 */
const incrementOutsideCounter = async (vehicleId) => {
    try {
        await sequelize.query(
            `UPDATE vehicle_security
             SET consecutive_outside_count = consecutive_outside_count + 1,
                 last_outside_at = NOW()
             WHERE voiture_id = ?`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.UPDATE }
        );
        // Read back the new value
        const [row] = await sequelize.query(
            'SELECT consecutive_outside_count FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        return parseInt(row?.consecutive_outside_count) || 1;
    } catch (err) {
        logger.error(`❌ incrementOutsideCounter: ${err.message}`);
        return 1;
    }
};

/** Reset the counter when the vehicle returns inside. */
const resetOutsideCounter = async (vehicleId) => {
    try {
        await sequelize.query(
            `UPDATE vehicle_security
             SET consecutive_outside_count = 0, last_outside_at = NULL
             WHERE voiture_id = ?`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.UPDATE }
        );
    } catch (err) {
        logger.error(`❌ resetOutsideCounter: ${err.message}`);
    }
};

const getActiveGeofenceAlert = async (vehicleId) => {
    try {
        const [alert] = await sequelize.query(
            `SELECT id, alerted_at, alert_subtype, alert_status
             FROM alerts
             WHERE voiture_id = ? AND alert_type = 'geofence'
               AND alert_subtype = 'LEFT_ZONE' AND alert_status = 'ACTIVE'
             ORDER BY alerted_at DESC LIMIT 1`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        return alert || null;
    } catch (err) {
        logger.error(`❌ getActiveGeofenceAlert: ${err.message}`);
        return null;
    }
};

const resolveAlert = async (alertId) => {
    try {
        await sequelize.query(
            `UPDATE alerts SET alert_status = 'RESOLVED' WHERE id = ?`,
            { replacements: [alertId], type: sequelize.QueryTypes.UPDATE }
        );
        logger.info(`✅ Alert ${alertId} resolved`);
        return true;
    } catch (err) {
        logger.error(`❌ resolveAlert: ${err.message}`);
        return false;
    }
};

const formatTimeAgo = (minutes) => {
    if (minutes === 0)  return 'just now';
    if (minutes === 1)  return '1 minute ago';
    return `${minutes} minutes ago`;
};

// ── initialize state ──────────────────────────────────────────────────────────
const initializeGeofenceState = async (vehicleId) => {
    try {
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!voiture || !voiture.geofence_zone) return { success: false, reason: 'No geofence defined' };

        const [location] = await sequelize.query(
            'SELECT latitude, longitude FROM locations WHERE mac_id_gps = ? AND latitude != 0 AND longitude != 0 ORDER BY sys_time DESC LIMIT 1',
            { replacements: [voiture.mac_id_gps], type: sequelize.QueryTypes.SELECT }
        );
        if (!location) return { success: false, reason: 'No GPS data' };

        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone) : voiture.geofence_zone;
        } catch (_) { return { success: false, reason: 'Invalid geofence data' }; }

        const isInside     = isInsideGeofence(location.latitude, location.longitude, geofenceZone);
        const initialState = isInside ? 'inside' : 'outside';

        await sequelize.query(
            `UPDATE vehicle_security
             SET last_geofence_state = ?, last_state_change_at = NOW(),
                 consecutive_outside_count = 0, last_outside_at = NULL
             WHERE voiture_id = ?`,
            { replacements: [initialState, vehicleId], type: sequelize.QueryTypes.UPDATE }
        );

        logger.info(`✅ Geofence state initialized vehicleId=${vehicleId} state=${initialState}`);
        return { success: true, vehicleId, initialState, isInside, latitude: location.latitude, longitude: location.longitude };
    } catch (err) {
        logger.error(`❌ initializeGeofenceState: ${err.message}`);
        return { success: false, reason: 'Error', error: err.message };
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CHECK — called from location.js on every GPS update
// ══════════════════════════════════════════════════════════════════════════════
const checkGeofenceViolation = async (vehicleId, latitude, longitude) => {
    logger.debug(`\n🚨 [Geofence] check vehicleId=${vehicleId} pos=[${latitude},${longitude}]`);

    try {
        // ── STEP 1: vehicle + geofence zone ──────────────────────────────────
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!voiture) return { violation: false, reason: 'Vehicle not found' };

        // ── STEP 2: geofencing active? ────────────────────────────────────────
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!security || !security.is_active) return { violation: false, reason: 'Geofencing not active' };

        // ── STEP 2b: subscription check ───────────────────────────────────────
        const hasGeofence = await hasFeature(vehicleId, FEATURES.GEOFENCE);
        if (!hasGeofence) return { violation: false, reason: 'No geofence subscription' };

        // ── STEP 3: zone defined? ─────────────────────────────────────────────
        if (!voiture.geofence_zone) return { violation: false, reason: 'No geofence defined' };

        // ── STEP 4: VELOCITY / PLAUSIBILITY FILTER ────────────────────────────
        //  Compare new coordinate against last DB position.
        //  Reject if implied speed > MAX_PLAUSIBLE_SPEED_KMH.
        const plausibility = await isCoordinatePlausible(voiture.mac_id_gps, latitude, longitude);
        if (!plausibility.plausible) {
            logger.warn(`🛡️ [Geofence] Coordinate rejected — velocity filter ` +
                `(${plausibility.impliedSpeedKmh?.toFixed(0)} km/h) vehicleId=${vehicleId}`);
            return {
                violation: false,
                reason:    'coordinate_rejected_velocity',
                filter:    plausibility
            };
        }

        // ── STEP 5: parse zone ────────────────────────────────────────────────
        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone) : voiture.geofence_zone;
        } catch (_) { return { violation: false, reason: 'Invalid geofence data' }; }

        // ── STEP 6: inside or outside? ────────────────────────────────────────
        const isInside     = isInsideGeofence(latitude, longitude, geofenceZone);
        const currentState = isInside ? 'inside' : 'outside';
        logger.debug(`🎯 [Geofence] vehicleId=${vehicleId} state=${currentState}`);

        // ── STEP 7: previous state ────────────────────────────────────────────
        let stateInfo = await getCurrentGeofenceState(vehicleId);

        if (!stateInfo.lastStateChangeAt) {
            // First ever check — initialize silently
            const init = await initializeGeofenceState(vehicleId);
            if (init.success) {
                stateInfo = await getCurrentGeofenceState(vehicleId);
            }
        }

        const previousState = stateInfo.currentState;
        logger.debug(`📊 [Geofence] vehicleId=${vehicleId} prev=${previousState} curr=${currentState} ` +
            `outsideCount=${stateInfo.consecutiveOutsideCount}`);

        // ── STEP 8: handle outside readings with debounce ─────────────────────
        if (currentState === 'outside') {

            if (previousState === 'inside') {
                // First outside reading after being inside — start the counter
                const newCount = await incrementOutsideCounter(vehicleId);
                logger.info(`⏳ [Geofence] vehicleId=${vehicleId} outside reading #${newCount}/${OUTSIDE_CONFIRM_THRESHOLD} — waiting for confirmation`);

                if (newCount < OUTSIDE_CONFIRM_THRESHOLD) {
                    // Not enough consecutive outside readings yet — DO NOT alert
                    return {
                        violation:    false,
                        reason:       'awaiting_confirmation',
                        outsideCount: newCount,
                        threshold:    OUTSIDE_CONFIRM_THRESHOLD
                    };
                }

                // Threshold reached — this is a confirmed real exit
                logger.warn(`🚨 [Geofence] vehicleId=${vehicleId} CONFIRMED outside after ${newCount} readings — firing alert`);
                const crossingTime = new Date();
                await updateGeofenceState(vehicleId, 'outside', crossingTime);

                const existingAlert = await getActiveGeofenceAlert(vehicleId);
                if (!existingAlert) {
                    await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'LEFT_ZONE', crossingTime, true);
                }

                return {
                    violation:    true,
                    stateChanged: true,
                    previousState,
                    currentState: 'outside',
                    alertSubtype: 'LEFT_ZONE',
                    crossingTime: crossingTime.toISOString(),
                    outsideCount: newCount
                };

            } else {
                // Already in outside state — just keep incrementing for logging,
                // but don't fire another alert (existing alert guard handles this)
                await incrementOutsideCounter(vehicleId);
                logger.debug(`ℹ️ [Geofence] vehicleId=${vehicleId} still outside (state already = outside)`);
                return { violation: true, reason: 'still_outside' };
            }
        }

        // ── STEP 9: vehicle is INSIDE ─────────────────────────────────────────
        // Always reset the counter immediately when back inside
        await resetOutsideCounter(vehicleId);

        if (previousState === 'outside') {
            // Confirmed return — vehicle was genuinely outside (state = outside in DB)
            logger.info(`✅ [Geofence] vehicleId=${vehicleId} RETURNED inside`);
            const crossingTime = new Date();
            await updateGeofenceState(vehicleId, 'inside', crossingTime);

            const activeAlert = await getActiveGeofenceAlert(vehicleId);
            if (activeAlert) await resolveAlert(activeAlert.id);

            await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'RETURNED_ZONE', crossingTime, true);

            return {
                violation:    false,
                stateChanged: true,
                previousState,
                currentState: 'inside',
                alertSubtype: 'RETURNED_ZONE',
                crossingTime: crossingTime.toISOString()
            };

        } else if (previousState === 'inside') {
            // Still inside — but counter may have been incrementing from pending
            // outside readings that never hit the threshold (false alarm burst).
            // Counter already reset above. No alert.
            logger.debug(`ℹ️ [Geofence] vehicleId=${vehicleId} still inside — counter reset`);
            return { violation: false, reason: 'still_inside' };
        }

        return { violation: false, reason: 'no_change' };

    } catch (err) {
        logger.error(`❌ [Geofence] checkGeofenceViolation error: ${err.message}`);
        logger.error(err.stack);
        return { violation: false, reason: 'error', error: err.message };
    }
};

// ── create alert ──────────────────────────────────────────────────────────────
const createGeofenceAlert = async (vehicleId, voiture, latitude, longitude, alertSubtype, crossingTime, shouldSendPush) => {
    try {
        const [vehicleOwner] = await sequelize.query(
            'SELECT user_id FROM association_user_voitures WHERE voiture_id = ? LIMIT 1',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!vehicleOwner?.user_id) { logger.warn(`⚠️ No owner for vehicle ${vehicleId}`); return; }

        const userId       = vehicleOwner.user_id;
        const alertSettings = await getUserAlertSettings(userId);
        const locationInfo = await reverseGeocode(latitude, longitude);
        const locationName = formatLocationName(locationInfo);
        const vehicleName  = voiture.nickname || `${voiture.marque} ${voiture.model}`;
        const minutesSince = Math.round((Date.now() - new Date(crossingTime).getTime()) / 60_000);
        const timeText     = formatTimeAgo(minutesSince);

        const alertMessage    = alertSubtype === 'LEFT_ZONE'
            ? `Your vehicle ${vehicleName} left the defined zone ${timeText} via ${locationName}`
            : `Your vehicle ${vehicleName} returned to the defined zone ${timeText} via ${locationName}`;
        const notificationTitle = alertSubtype === 'LEFT_ZONE' ? '⚠️ Geofence Alert' : '✅ Vehicle Returned';

        const newAlert = await Alert.create({
            voiture_id:    vehicleId,
            alert_type:    'geofence',
            alert_subtype: alertSubtype,
            message:       alertMessage,
            latitude, longitude,
            alert_status:  'ACTIVE',
            alerted_at:    crossingTime,
            sent:          alertSettings.geofenceAlertsEnabled && shouldSendPush,
            read:          false
        });

        logger.info(`✅ Alert created id=${newAlert.id} type=${alertSubtype} vehicle=${vehicleId}`);

        if (shouldSendPush && alertSettings.geofenceAlertsEnabled) {
            try {
                await notificationController.sendToUser(userId, {
                    title: notificationTitle,
                    body:  alertMessage,
                    data:  {
                        type:             alertSubtype === 'LEFT_ZONE' ? 'geofence_violation' : 'geofence_return',
                        alertSubtype, vehicleId: String(vehicleId), vehicleName,
                        latitude: String(latitude), longitude: String(longitude),
                        locationName, formattedAddress: locationInfo.formattedAddress,
                        crossingTime: crossingTime.toISOString(), timestamp: new Date().toISOString()
                    }
                });
            } catch (notifErr) { logger.error(`❌ Push notification error: ${notifErr.message}`); }
        }

        if (socketService.isInitialized()) {
            try {
                socketService.emitToVehicle(vehicleId, 'geofence_alert', {
                    alertId: newAlert.id, type: alertSubtype,
                    severity: alertSubtype === 'LEFT_ZONE' ? 'warning' : 'info',
                    title: notificationTitle, message: alertMessage,
                    vehicleId, vehicleName, latitude, longitude,
                    locationName, formattedAddress: locationInfo.formattedAddress,
                    crossingTime: crossingTime.toISOString(), timestamp: new Date().toISOString()
                });
            } catch (sockErr) { logger.error(`❌ Socket.IO error: ${sockErr.message}`); }
        }

        return newAlert;
    } catch (err) {
        logger.error(`❌ createGeofenceAlert: ${err.message}`);
        throw err;
    }
};

// ── API endpoints ─────────────────────────────────────────────────────────────
const getGeofenceStatus = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone FROM voitures WHERE id = ?',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!voiture) return res.status(404).json({ error: 'Vehicle not found' });

        const [loc] = await sequelize.query(
            'SELECT latitude, longitude FROM locations WHERE mac_id_gps = ? AND latitude != 0 ORDER BY sys_time DESC LIMIT 1',
            { replacements: [voiture.mac_id_gps], type: sequelize.QueryTypes.SELECT }
        );
        if (!loc) return res.status(404).json({ error: 'No location data available' });

        const result = await checkGeofenceViolation(vehicleId, loc.latitude, loc.longitude);
        res.json({ success: true, vehicleId, currentLocation: { latitude: loc.latitude, longitude: loc.longitude }, geofenceStatus: result });
    } catch (err) {
        logger.error(`❌ getGeofenceStatus: ${err.message}`);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
};

const initializeGeofenceStateEndpoint = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const result = await initializeGeofenceState(vehicleId);
        if (result.success) res.json({ success: true, message: 'Geofence state initialized', data: result });
        else res.status(400).json({ success: false, message: result.reason, data: result });
    } catch (err) {
        logger.error(`❌ initializeGeofenceStateEndpoint: ${err.message}`);
        res.status(500).json({ success: false, message: 'Server error', error: err.message });
    }
};

module.exports = {
    checkGeofenceViolation,
    getGeofenceStatus,
    initializeGeofenceState,
    initializeGeofenceStateEndpoint
};