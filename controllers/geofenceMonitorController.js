// controllers/geofenceMonitorController.js

const Alert           = require('../models/Alert');
const notificationController = require('./notificationController');
const sequelize       = require('../config/database');
const { isInsideGeofence } = require('../services/geofenceService');
const socketService   = require('../services/socketService');
const axios            = require('axios');
const logger            = require('../utils/logger');
const redisClient       = require('../config/redis');
const engineCutService  = require('../services/geofenceEngineCutService');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ── tuneable constants ────────────────────────────────────────────────────────
const MAX_PLAUSIBLE_SPEED_KMH    = 200;
const OUTSIDE_CONFIRM_THRESHOLD  = 3;
const INSIDE_CONFIRM_THRESHOLD   = 3;   // symmetric with OUTSIDE_CONFIRM_THRESHOLD
const ALERT_COOLDOWN_MS          = 2 * 60 * 1000; // 2 minutes — suppresses repeat alerts of the same type/vehicle
const POSITION_CACHE_TTL_SECONDS = 3600;
// ─────────────────────────────────────────────────────────────────────────────

// ── ephemeral (in-memory, per-process) geofence debounce/cooldown state ──────
// vehicle_security only has durable columns for last_geofence_state,
// last_state_change_at, consecutive_outside_count and last_outside_at.
// The symmetric "returning inside" debounce counter and the two alert-cooldown
// timestamps have no backing column (and none is being added — no DB schema
// changes for this feature), so they live here instead. Resetting on process
// restart is acceptable: worst case is one extra confirmation cycle or one
// extra alert right after a restart, not a correctness issue.
const ephemeralGeofenceState = new Map(); // vehicleId -> { consecutiveInsideCount, lastInsideAt, lastLeftZoneAlertAt, lastReturnedAlertAt }

const getEphemeralState = (vehicleId) => {
    if (!ephemeralGeofenceState.has(vehicleId)) {
        ephemeralGeofenceState.set(vehicleId, {
            consecutiveInsideCount: 0,
            lastInsideAt: null,
            lastLeftZoneAlertAt: null,
            lastReturnedAlertAt: null,
        });
    }
    return ephemeralGeofenceState.get(vehicleId);
};
// ─────────────────────────────────────────────────────────────────────────────

// ── per-vehicle async lock ────────────────────────────────────────────────────
// checkGeofenceViolation is NOT read-only: it reads state, decides, and writes
// state + creates alerts. It's invoked from two independent places — the
// background GPS poller (location.js, on a timer) AND the live per-vehicle
// HTTP status endpoint (getGeofenceStatus below, hit by the dashboard while a
// vehicle's detail view is open). Without serialization, two calls for the
// SAME vehicle arriving close together can both read the pre-crossing state
// (including the debounce counter and the alert cooldown timestamp) before
// either writes back the post-crossing state — each independently concludes
// "this is a confirmed, non-cooldown crossing" and each creates its own alert.
// That's what produced duplicate RETURNED_ZONE alerts at the same timestamp.
// This queues calls per vehicleId so only one is ever inside the
// read-decide-write section at a time; other vehicles are unaffected.
const vehicleLocks = new Map(); // key: String(vehicleId) -> Promise (tail of the queue)

const withVehicleLock = (vehicleId, fn) => {
    const key      = String(vehicleId);
    const previous = vehicleLocks.get(key) || Promise.resolve();
    const run      = previous.then(fn, fn); // run fn even if the previous call in the queue failed
    // Keep the chain alive for the next caller, but never let a rejection propagate into it.
    vehicleLocks.set(key, run.catch(() => {}));
    return run;
};
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

// ── position cache (Redis) ────────────────────────────────────────────────────
// Written by isCoordinatePlausible() every time a point is accepted, so the
// NEXT call can skip the DB round-trip entirely. This is what makes the
// Redis path in isCoordinatePlausible actually hit instead of always missing.
const cacheLastPosition = async (macIdGps, latitude, longitude, sysTime = new Date()) => {
    try {
        const payload = JSON.stringify({ latitude, longitude, sys_time: sysTime.toISOString() });
        // NOTE: adjust to your redis client's API if this differs.
        // ioredis / node-redis v3 style shown below:
        await redisClient.set(`gps:last:${macIdGps}`, payload, 'EX', POSITION_CACHE_TTL_SECONDS);
        // node-redis v4 style would instead be:
        // await redisClient.set(`gps:last:${macIdGps}`, payload, { EX: POSITION_CACHE_TTL_SECONDS });
    } catch (err) {
        logger.error(`❌ cacheLastPosition: ${err.message}`);
    }
};

// ── velocity / plausibility filter ───────────────────────────────────────────
// IMPORTANT: by the time this runs, the CURRENT point has ALREADY been
// inserted into `locations` upstream (location.js saves before calling the
// geofence check). On a Redis miss, LIMIT 1 would therefore return the point
// being validated, not the prior one — always yielding distance=0 and
// silently disabling this filter. OFFSET 1 skips that just-inserted row and
// gets the true previous fix. The Redis cache (written below on every accept)
// avoids paying this cost — and this ordering quirk — on every single call.
const isCoordinatePlausible = async (macIdGps, newLat, newLng) => {
    try {
        let prevLat, prevLng, prevTime;

        const cached = await redisClient.get(`gps:last:${macIdGps}`);
        if (cached) {
            const p = JSON.parse(cached);
            prevLat  = parseFloat(p.latitude);
            prevLng  = parseFloat(p.longitude);
            prevTime = new Date(p.sys_time);
            logger.debug(`🛡️ [VelocityFilter] Redis HIT mac=${macIdGps}`);
        } else {
            logger.debug(`🛡️ [VelocityFilter] Redis MISS mac=${macIdGps} — querying DB (offset 1, current point already inserted)`);
            const rows = await sequelize.query(
                `SELECT latitude, longitude, sys_time
                 FROM   locations
                 WHERE  mac_id_gps = :mac
                   AND  latitude  != 0
                   AND  longitude != 0
                 ORDER  BY sys_time DESC
                 LIMIT  1 OFFSET 1`,
                { replacements: { mac: macIdGps }, type: sequelize.QueryTypes.SELECT }
            );
            if (!rows || rows.length === 0) {
                // No prior fix to compare against — accept, and seed the cache
                // so the next call has a correct, fast baseline.
                await cacheLastPosition(macIdGps, newLat, newLng);
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
            // Do NOT cache a rejected point — that would poison the next comparison.
            return { plausible: false, reason: 'velocity_exceeded', distKm, impliedSpeedKmh };
        }

        // Accepted — this becomes the baseline for the next call.
        await cacheLastPosition(macIdGps, newLat, newLng);
        return { plausible: true, reason: 'ok', distKm, impliedSpeedKmh };

    } catch (err) {
        logger.error(`❌ [VelocityFilter] error: ${err.message}`);
        return { plausible: true, reason: 'filter_error' };
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
                if (c.types.includes('neighborhood'))                                                       neighborhood      = c.long_name;
                else if (c.types.includes('route'))                                                         route             = c.long_name;
                else if (c.types.includes('sublocality') || c.types.includes('sublocality_level_1'))        sublocality       = c.long_name;
                else if (c.types.includes('locality'))                                                      locality          = c.long_name;
                else if (c.types.includes('administrative_area_level_2') && !locality)                      administrativeArea = c.long_name;
                else if (c.types.includes('administrative_area_level_1') && !locality && !administrativeArea) administrativeArea = c.long_name;
                else if (c.types.includes('country'))                                                       country           = c.long_name;
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
    const ephemeral = getEphemeralState(vehicleId);
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
                consecutiveInsideCount:  ephemeral.consecutiveInsideCount,
                lastInsideAt:            ephemeral.lastInsideAt,
                lastLeftZoneAlertAt:     ephemeral.lastLeftZoneAlertAt,
                lastReturnedAlertAt:     ephemeral.lastReturnedAlertAt,
            };
        }
        // No vehicle_security row — treat as fresh/inside state
        return {
            currentState: 'inside', lastStateChangeAt: null,
            consecutiveOutsideCount: 0, lastOutsideAt: null,
            consecutiveInsideCount: ephemeral.consecutiveInsideCount, lastInsideAt: ephemeral.lastInsideAt,
            lastLeftZoneAlertAt: ephemeral.lastLeftZoneAlertAt, lastReturnedAlertAt: ephemeral.lastReturnedAlertAt,
        };
    } catch (err) {
        logger.error(`❌ getCurrentGeofenceState: ${err.message}`);
        return {
            currentState: 'inside', lastStateChangeAt: null,
            consecutiveOutsideCount: 0, lastOutsideAt: null,
            consecutiveInsideCount: ephemeral.consecutiveInsideCount, lastInsideAt: ephemeral.lastInsideAt,
            lastLeftZoneAlertAt: ephemeral.lastLeftZoneAlertAt, lastReturnedAlertAt: ephemeral.lastReturnedAlertAt,
        };
    }
};

const updateGeofenceState = async (vehicleId, newState, crossingTime) => {
    try {
        await sequelize.query(
            `INSERT INTO vehicle_security (voiture_id, last_geofence_state, last_state_change_at, createdAt, updatedAt)
             VALUES (?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               last_geofence_state    = VALUES(last_geofence_state),
               last_state_change_at   = VALUES(last_state_change_at),
               updatedAt             = NOW()`,
            { replacements: [vehicleId, newState, crossingTime], type: sequelize.QueryTypes.INSERT }
        );
        return true;
    } catch (err) {
        logger.error(`❌ updateGeofenceState: ${err.message}`);
        return false;
    }
};

const incrementOutsideCounter = async (vehicleId) => {
    // Trending outside — the symmetric inside counter resets (ephemeral, no DB column for it).
    getEphemeralState(vehicleId).consecutiveInsideCount = 0;
    try {
        await sequelize.query(
            `INSERT INTO vehicle_security (voiture_id, consecutive_outside_count, last_outside_at, createdAt, updatedAt)
             VALUES (?, 1, NOW(), NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               consecutive_outside_count = consecutive_outside_count + 1,
               last_outside_at           = NOW(),
               updatedAt                = NOW()`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.INSERT }
        );
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

// ── NEW: symmetric counterpart to incrementOutsideCounter ─────────────────────
const incrementInsideCounter = async (vehicleId) => {
    const ephemeral = getEphemeralState(vehicleId);
    ephemeral.consecutiveInsideCount += 1;
    ephemeral.lastInsideAt = new Date();

    try {
        await sequelize.query(
            `INSERT INTO vehicle_security (voiture_id, consecutive_outside_count, createdAt, updatedAt)
             VALUES (?, 0, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               consecutive_outside_count = 0,
               updatedAt                = NOW()`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.INSERT }
        );
    } catch (err) {
        logger.error(`❌ incrementInsideCounter: ${err.message}`);
    }
    return ephemeral.consecutiveInsideCount;
};

// ── NEW: zero both crossing counters at once (used right after a confirmed crossing) ──
const resetCrossingCounters = async (vehicleId) => {
    const ephemeral = getEphemeralState(vehicleId);
    ephemeral.consecutiveInsideCount = 0;
    ephemeral.lastInsideAt = null;

    try {
        await sequelize.query(
            `INSERT INTO vehicle_security (voiture_id, consecutive_outside_count, last_outside_at, createdAt, updatedAt)
             VALUES (?, 0, NULL, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               consecutive_outside_count = 0,
               last_outside_at           = NULL,
               updatedAt                = NOW()`,
            { replacements: [vehicleId], type: sequelize.QueryTypes.INSERT }
        );
    } catch (err) {
        logger.error(`❌ resetCrossingCounters: ${err.message}`);
    }
};

// ── NEW: alert cooldown helpers (ephemeral — see ephemeralGeofenceState above) ──
const ALERT_TIMESTAMP_FIELDS = new Set(['lastLeftZoneAlertAt', 'lastReturnedAlertAt']);

const isAlertOnCooldown = (lastAlertAt) => {
    if (!lastAlertAt) return false; // first alert of its kind always fires
    return (Date.now() - lastAlertAt.getTime()) < ALERT_COOLDOWN_MS;
};

const recordAlertTimestamp = (vehicleId, field) => {
    if (!ALERT_TIMESTAMP_FIELDS.has(field)) {
        logger.error(`❌ recordAlertTimestamp: rejected unknown field "${field}"`);
        return;
    }
    getEphemeralState(vehicleId)[field] = new Date();
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

        // Upsert — works with or without an existing vehicle_security row.
        // Alert cooldown state is intentionally left untouched here: a
        // (re)initialization is a state-tracking reset, not an alert-history reset.
        await sequelize.query(
            `INSERT INTO vehicle_security
               (voiture_id, last_geofence_state, last_state_change_at,
                consecutive_outside_count, last_outside_at,
                createdAt, updatedAt)
             VALUES (?, ?, NOW(), 0, NULL, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               last_geofence_state       = VALUES(last_geofence_state),
               last_state_change_at      = NOW(),
               consecutive_outside_count = 0,
               last_outside_at           = NULL,
               updatedAt                = NOW()`,
            { replacements: [vehicleId, initialState], type: sequelize.QueryTypes.INSERT }
        );
        getEphemeralState(vehicleId).consecutiveInsideCount = 0;
        getEphemeralState(vehicleId).lastInsideAt = null;

        logger.info(`✅ Geofence state initialized vehicleId=${vehicleId} state=${initialState}`);
        return { success: true, vehicleId, initialState, isInside, latitude: location.latitude, longitude: location.longitude };
    } catch (err) {
        logger.error(`❌ initializeGeofenceState: ${err.message}`);
        return { success: false, reason: 'Error', error: err.message };
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CHECK — called from location.js on every GPS update, and from the
// getGeofenceStatus HTTP endpoint below. Wrapped in withVehicleLock so the two
// call sites (or two overlapping HTTP polls) can never race each other for the
// same vehicle — see the vehicleLocks comment above.
// ══════════════════════════════════════════════════════════════════════════════
const checkGeofenceViolation = (vehicleId, latitude, longitude) =>
    withVehicleLock(vehicleId, () => checkGeofenceViolationLocked(vehicleId, latitude, longitude));

const checkGeofenceViolationLocked = async (vehicleId, latitude, longitude) => {
    logger.debug(`\n🚨 [Geofence] check vehicleId=${vehicleId} pos=[${latitude},${longitude}]`);

    try {
        // ── STEP 1: vehicle + geofence zone ──────────────────────────────────
        const [voiture] = await sequelize.query(
            'SELECT id, mac_id_gps, geofence_zone, nickname, marque, model FROM voitures WHERE id = ?',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!voiture) return { violation: false, reason: 'Vehicle not found' };

        // ── STEP 2: zone defined? ─────────────────────────────────────────────
        // NOTE: is_active is intentionally NOT checked here.
        // Geofence monitoring runs for ALL vehicles that have a geofence_zone,
        // regardless of whether vehicle_security.is_active is true or false.
        if (!voiture.geofence_zone) return { violation: false, reason: 'No geofence defined' };

        // ── STEP 3: VELOCITY / PLAUSIBILITY FILTER (defense-in-depth) ─────────
        // location.js's classifyGpsPoint() is the primary "is this a real
        // position" gate and already blocks alerting via gpsData.alertSafe
        // for low-confidence/noisy points before checkGeofenceViolation is
        // even called. This second check is a cheap backstop specific to
        // geofence crossings — kept correct via OFFSET 1 + the Redis cache above.
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

        // ── STEP 4: parse zone ────────────────────────────────────────────────
        let geofenceZone;
        try {
            geofenceZone = typeof voiture.geofence_zone === 'string'
                ? JSON.parse(voiture.geofence_zone) : voiture.geofence_zone;
        } catch (_) { return { violation: false, reason: 'Invalid geofence data' }; }


        // ── STEP 4b: validate zone has enough points ────────────────────────
        if (!Array.isArray(geofenceZone) || geofenceZone.length < 3) {
            logger.warn(
                `⚠️ [Geofence] vehicleId=${vehicleId} geofence_zone has ${Array.isArray(geofenceZone) ? geofenceZone.length : 0} point(s) — ` +
                `need at least 3 to form a polygon. Skipping check. Fix the zone data for this vehicle in the DB.`
            );
            return { violation: false, reason: 'geofence_zone_too_few_points' };
        }
        // ── STEP 5: inside or outside? ────────────────────────────────────────
        const isInside     = isInsideGeofence(latitude, longitude, geofenceZone);
        const currentState = isInside ? 'inside' : 'outside';
        logger.debug(`🎯 [Geofence] vehicleId=${vehicleId} state=${currentState}`);

        // ── STEP 6: previous state ────────────────────────────────────────────
        let stateInfo = await getCurrentGeofenceState(vehicleId);

        if (!stateInfo.lastStateChangeAt) {
            const init = await initializeGeofenceState(vehicleId);
            if (init.success) {
                stateInfo = await getCurrentGeofenceState(vehicleId);
            }
        }

        const previousState = stateInfo.currentState;
        logger.debug(`📊 [Geofence] vehicleId=${vehicleId} prev=${previousState} curr=${currentState} ` +
            `outsideCount=${stateInfo.consecutiveOutsideCount} insideCount=${stateInfo.consecutiveInsideCount}`);

        // ── STEP 7: handle outside readings with debounce ─────────────────────
        if (currentState === 'outside') {

            if (previousState === 'inside') {
                const newCount = await incrementOutsideCounter(vehicleId);
                logger.info(`⏳ [Geofence] vehicleId=${vehicleId} outside reading #${newCount}/${OUTSIDE_CONFIRM_THRESHOLD} — waiting for confirmation`);

                if (newCount < OUTSIDE_CONFIRM_THRESHOLD) {
                    return {
                        violation:    false,
                        reason:       'awaiting_confirmation',
                        outsideCount: newCount,
                        threshold:    OUTSIDE_CONFIRM_THRESHOLD
                    };
                }

                // Threshold reached — confirmed real exit. State always updates,
                // independent of whether the alert itself gets throttled below.
                logger.warn(`🚨 [Geofence] vehicleId=${vehicleId} CONFIRMED outside after ${newCount} readings`);
                const crossingTime = new Date();
                await updateGeofenceState(vehicleId, 'outside', crossingTime);
                await resetCrossingCounters(vehicleId);

                const onCooldown = isAlertOnCooldown(stateInfo.lastLeftZoneAlertAt);

                // ── LEFT_ZONE alert — resolved before the cutoff block below so the
                // resulting command's audit row (commands.trigger_alert_id) can point
                // at the exact alert that triggered it.
                let alertCreated  = false;
                let existingAlert = await getActiveGeofenceAlert(vehicleId);
                let leftZoneAlertId = existingAlert?.id || null;

                if (onCooldown) {
                    logger.info(`🧊 [Geofence] vehicleId=${vehicleId} LEFT_ZONE alert suppressed — cooldown active (last at ${stateInfo.lastLeftZoneAlertAt.toISOString()})`);
                } else if (!existingAlert) {
                    const newAlert = await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'LEFT_ZONE', crossingTime);
                    recordAlertTimestamp(vehicleId, 'lastLeftZoneAlertAt');
                    alertCreated    = true;
                    leftZoneAlertId = newAlert?.id || null;
                }

                // ── Lease-partner engine cutoff — the cutoff itself (startSpeedWatcher)
                // runs on every confirmed exit regardless of cooldown, since actually
                // cutting the engine is safety-critical and must not be skipped just
                // because a notification was recently sent. The WARNING NOTIFICATION,
                // though, previously bypassed the cooldown entirely — meaning a vehicle
                // oscillating across the boundary (confirmed-out -> confirmed-in ->
                // confirmed-out...) sent a fresh "Engine Will Be Cut" push every single
                // time, unlike every other alert in this file. It's now gated by the
                // same cooldown as the regular LEFT_ZONE alert below.
                try {
                    const leaseInfo = await engineCutService.isLeasePartnerVehicle(vehicleId);
                    if (leaseInfo.isLease) {
                        const vehicleName = voiture.nickname || `${voiture.marque} ${voiture.model}`;
                        logger.warn(`🔴 [Geofence] vehicleId=${vehicleId} belongs to LEASE_PARTNER "${leaseInfo.partnerName}" — starting engine cutoff`);
                        if (!onCooldown) {
                            const locationInfo = await reverseGeocode(latitude, longitude);
                            const locationName = formatLocationName(locationInfo);
                            await engineCutService.sendGeofenceWarningNotifications(vehicleId, vehicleName, locationName, leaseInfo.partnerId);
                        }
                        await engineCutService.startSpeedWatcher(vehicleId, vehicleName, leaseInfo.partnerId, leftZoneAlertId);
                    }
                } catch (cutErr) {
                    logger.error(`❌ [Geofence] lease cutoff check failed for vehicle ${vehicleId}: ${cutErr.message}`);
                }

                return {
                    violation:       true,
                    stateChanged:    true,
                    previousState,
                    currentState:    'outside',
                    alertSubtype:    'LEFT_ZONE',
                    crossingTime:    crossingTime.toISOString(),
                    outsideCount:    newCount,
                    alertCreated,
                    alertSuppressed: onCooldown
                };

            } else {
                // Already confirmed outside — increment for telemetry, never re-alert here
                await incrementOutsideCounter(vehicleId);
                logger.debug(`ℹ️ [Geofence] vehicleId=${vehicleId} still outside`);
                return { violation: true, reason: 'still_outside' };
            }
        }

        // ── STEP 8: vehicle is INSIDE (symmetric to STEP 7) ────────────────────
        if (previousState === 'outside') {
            const newCount = await incrementInsideCounter(vehicleId);
            logger.info(`⏳ [Geofence] vehicleId=${vehicleId} inside reading #${newCount}/${INSIDE_CONFIRM_THRESHOLD} — waiting for return confirmation`);

            if (newCount < INSIDE_CONFIRM_THRESHOLD) {
                // last_geofence_state is still 'outside' until confirmed, so this
                // correctly continues to report a violation in progress.
                return {
                    violation:   true,
                    reason:      'awaiting_return_confirmation',
                    insideCount: newCount,
                    threshold:   INSIDE_CONFIRM_THRESHOLD
                };
            }

            // Threshold reached — confirmed real return
            logger.info(`✅ [Geofence] vehicleId=${vehicleId} CONFIRMED return after ${newCount} readings`);
            const crossingTime = new Date();
            await updateGeofenceState(vehicleId, 'inside', crossingTime);
            await resetCrossingCounters(vehicleId);

            // Vehicle is back inside — abort any pending engine cutoff for it.
            // No-op if this vehicle isn't a lease-partner vehicle or has no active watcher.
            engineCutService.cancelSpeedWatcher(vehicleId);

            const activeAlert = await getActiveGeofenceAlert(vehicleId);
            if (activeAlert) await resolveAlert(activeAlert.id);

            const onCooldown = isAlertOnCooldown(stateInfo.lastReturnedAlertAt);
            let alertCreated = false;
            if (onCooldown) {
                logger.info(`🧊 [Geofence] vehicleId=${vehicleId} RETURNED_ZONE alert suppressed — cooldown active (last at ${stateInfo.lastReturnedAlertAt.toISOString()})`);
            } else {
                await createGeofenceAlert(vehicleId, voiture, latitude, longitude, 'RETURNED_ZONE', crossingTime);
                recordAlertTimestamp(vehicleId, 'lastReturnedAlertAt');
                alertCreated = true;
            }

            return {
                violation:       false,
                stateChanged:    true,
                previousState,
                currentState:    'inside',
                alertSubtype:    'RETURNED_ZONE',
                crossingTime:    crossingTime.toISOString(),
                insideCount:     newCount,
                alertCreated,
                alertSuppressed: onCooldown
            };

        } else if (previousState === 'inside') {
            logger.debug(`ℹ️ [Geofence] vehicleId=${vehicleId} still inside`);
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
// Alert is always created in DB and push notification always sent.
// No subscription check — that is handled upstream if ever needed.
const createGeofenceAlert = async (vehicleId, voiture, latitude, longitude, alertSubtype, crossingTime) => {
    try {
        const [vehicleOwner] = await sequelize.query(
            'SELECT user_id FROM association_user_voitures WHERE voiture_id = ? LIMIT 1',
            { replacements: [vehicleId], type: sequelize.QueryTypes.SELECT }
        );
        if (!vehicleOwner?.user_id) { logger.warn(`⚠️ No owner for vehicle ${vehicleId}`); return; }

        const userId       = vehicleOwner.user_id;
        const locationInfo = await reverseGeocode(latitude, longitude);
        const locationName = formatLocationName(locationInfo);
        const vehicleName  = voiture.nickname || `${voiture.marque} ${voiture.model}`;
        const minutesSince = Math.round((Date.now() - new Date(crossingTime).getTime()) / 60_000);
        const timeText     = formatTimeAgo(minutesSince);

        const alertMessage      = alertSubtype === 'LEFT_ZONE'
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
            sent:          true,
            read:          false
        });

        logger.info(`✅ Alert created id=${newAlert.id} type=${alertSubtype} vehicle=${vehicleId}`);

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