
const sequelize              = require('../config/database');
const { sendGpsCommandWithFallback } = require('./GpsService');
const notificationController = require('../controllers/notificationController');
const logger                 = require('../utils/logger');

// ── tuneable constants ────────────────────────────────────────────────────────
const SPEED_CUT_THRESHOLD_KMH = 15;   // cut engine when speed drops below this
const POLL_INTERVAL_MS        = 8000; // check speed every 8 seconds
const MAX_WATCH_MINUTES       = 10;   // give up after 10 minutes
const MAX_WATCH_MS            = MAX_WATCH_MINUTES * 60 * 1000;

// Real CLOSERELAY commands are dangerous (cuts a vehicle's engine remotely,
// irreversible from here once sent) and this codebase has no other simulation
// gate anywhere. Default OFF — logs what it would have sent instead of sending
// it — until this has been verified end-to-end and explicitly turned on.
const CUTOFF_EXECUTION_ENABLED = String(process.env.GEOFENCE_CUTOFF_EXECUTION_ENABLED || 'false').toLowerCase() === 'true';
// ─────────────────────────────────────────────────────────────────────────────


const activeWatchers = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: resolve mac_id_gps + account_name for a vehicleId
// ─────────────────────────────────────────────────────────────────────────────
const resolveVehicleGps = async (vehicleId) => {
    const [row] = await sequelize.query(
        `SELECT v.mac_id_gps, s.account_name
         FROM   voitures  v
         JOIN   sim_gps   s ON s.mac_id = v.mac_id_gps
         WHERE  v.id = :vehicleId
         ORDER  BY s.updated_at DESC
         LIMIT  1`,
        { replacements: { vehicleId }, type: sequelize.QueryTypes.SELECT }
    );
    return row || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: get current speed from locations table
// ─────────────────────────────────────────────────────────────────────────────
const getCurrentSpeed = async (macIdGps) => {
    try {
        const [row] = await sequelize.query(
            `SELECT speed FROM locations
             WHERE  mac_id_gps = :mac
               AND  latitude  != 0
               AND  longitude != 0
             ORDER  BY sys_time DESC
             LIMIT  1`,
            { replacements: { mac: macIdGps }, type: sequelize.QueryTypes.SELECT }
        );
        return row ? parseFloat(row.speed) || 0 : null;
    } catch (err) {
        logger.error(`❌ [EngineCut] getCurrentSpeed error: ${err.message}`);
        return null;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: mark vehicle as geofence-locked in vehicle_security
// ─────────────────────────────────────────────────────────────────────────────
const markGeofenceLocked = async (vehicleId) => {
    try {
        await sequelize.query(
            `UPDATE vehicle_security
             SET    geofence_locked    = 1,
                    geofence_locked_at = NOW(),
                    geofence_locked_by = 'AUTO_GEOFENCE',
                    updatedAt          = NOW()
             WHERE  voiture_id = :vehicleId`,
            { replacements: { vehicleId }, type: sequelize.QueryTypes.UPDATE }
        );
        logger.info(`🔒 [EngineCut] vehicle ${vehicleId} marked geofence_locked=1`);
        return true;
    } catch (err) {
        logger.error(`❌ [EngineCut] markGeofenceLocked error: ${err.message}`);
        return false;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: send notification to a userId (fire-and-forget, silent fail)
// ─────────────────────────────────────────────────────────────────────────────
const safeSendNotification = async (userId, title, body, data = {}) => {
    try {
        await notificationController.sendToUser(userId, { title, body, data });
    } catch (err) {
        logger.error(`❌ [EngineCut] notification to user ${userId} failed: ${err.message}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: get driver userId and partner userId for a vehicle
//
//   ROYAL HOLDINGS vehicles are assigned via association_chauffeur_voiture_partner.
//   The chauffeur row has partner_id pointing to Frank William (user 21, LEASE_PARTNER).
// ─────────────────────────────────────────────────────────────────────────────
const resolveVehicleUsers = async (vehicleId) => {
    try {
        // Driver: the chauffeur currently assigned to this vehicle
        const [driverRow] = await sequelize.query(
            `SELECT u.id AS driver_id, u.nom, u.prenom
             FROM   association_chauffeur_voiture_partner acvp
             JOIN   users u ON u.id = acvp.chauffeur_id
             WHERE  acvp.voiture_id = :vehicleId
             ORDER  BY acvp.assigned_at DESC
             LIMIT  1`,
            { replacements: { vehicleId }, type: sequelize.QueryTypes.SELECT }
        );

        if (!driverRow) {
            logger.warn(`⚠️ [EngineCut] No driver found for vehicle ${vehicleId}`);
            return { driverId: null, partnerId: null };
        }

        // Partner: look up the driver's partner_id
        const [partnerRow] = await sequelize.query(
            `SELECT u.partner_id FROM users u WHERE u.id = :driverId LIMIT 1`,
            { replacements: { driverId: driverRow.driver_id }, type: sequelize.QueryTypes.SELECT }
        );

        const partnerId = partnerRow?.partner_id || null;

        return {
            driverId:  driverRow.driver_id,
            partnerId: partnerId
        };
    } catch (err) {
        logger.error(`❌ [EngineCut] resolveVehicleUsers error: ${err.message}`);
        return { driverId: null, partnerId: null };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Check if a vehicle belongs to a LEASE_PARTNER (e.g. Royal Holdings).
//
// Logic:
//   The vehicle is in association_chauffeur_voiture_partner (not association_user_voitures).
//   The chauffeur user row has a partner_id, and that partner's type_partner = 'LEASE_PARTNER'.
//
// Returns: { isLease: bool, partnerId: number|null, partnerName: string|null }
// ─────────────────────────────────────────────────────────────────────────────
const isLeasePartnerVehicle = async (vehicleId) => {
    try {
        const [row] = await sequelize.query(
            `SELECT p.id          AS partner_id,
                    p.nom         AS partner_nom,
                    p.prenom      AS partner_prenom,
                    p.type_partner
             FROM   association_chauffeur_voiture_partner acvp
             JOIN   users driver  ON driver.id      = acvp.chauffeur_id
             JOIN   users p       ON p.id           = driver.partner_id
             WHERE  acvp.voiture_id = :vehicleId
               AND  p.type_partner  = 'LEASE_PARTNER'
             LIMIT  1`,
            { replacements: { vehicleId }, type: sequelize.QueryTypes.SELECT }
        );

        if (!row) return { isLease: false, partnerId: null, partnerName: null };

        return {
            isLease:     true,
            partnerId:   row.partner_id,
            partnerName: `${row.partner_nom} ${row.partner_prenom}`.trim()
        };
    } catch (err) {
        logger.error(`❌ [EngineCut] isLeasePartnerVehicle error: ${err.message}`);
        return { isLease: false, partnerId: null, partnerName: null };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Send immediate LEFT_ZONE warning notifications (before engine cut).
//         Called right when LEFT_ZONE is confirmed.
// ─────────────────────────────────────────────────────────────────────────────
const sendGeofenceWarningNotifications = async (vehicleId, vehicleName, locationName, partnerId) => {
    const { driverId } = await resolveVehicleUsers(vehicleId);

    // Notify the driver
    if (driverId) {
        await safeSendNotification(
            driverId,
            '⚠️ Zone Alert — Engine Will Be Cut',
            `You have left the authorized zone. The engine of ${vehicleName} will be turned off once you slow down.`,
            {
                type:       'geofence_engine_warning',
                vehicleId:  String(vehicleId),
                vehicleName,
                locationName
            }
        );
        logger.info(`📲 [EngineCut] Warning sent to driver ${driverId} for vehicle ${vehicleId}`);
    }

    // Notify the partner (Frank William)
    if (partnerId) {
        await safeSendNotification(
            partnerId,
            '⚠️ Geofence Breach — Engine Cut Pending',
            `Vehicle ${vehicleName} has left the authorized zone at ${locationName}. Engine cut will be executed when speed drops below ${SPEED_CUT_THRESHOLD_KMH} km/h.`,
            {
                type:       'geofence_engine_warning',
                vehicleId:  String(vehicleId),
                vehicleName,
                locationName
            }
        );
        logger.info(`📲 [EngineCut] Warning sent to partner ${partnerId} for vehicle ${vehicleId}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Start the speed watcher for a vehicle.
//
//   - Polls speed every POLL_INTERVAL_MS.
//   - Cuts engine when speed < SPEED_CUT_THRESHOLD_KMH.
//   - Gives up after MAX_WATCH_MINUTES and notifies partner that cut failed.
//   - One watcher per vehicle (duplicate calls are ignored).
// ─────────────────────────────────────────────────────────────────────────────
const startSpeedWatcher = async (vehicleId, vehicleName, partnerId) => {

    // Guard: don't start a second watcher for the same vehicle
    if (activeWatchers.has(vehicleId)) {
        logger.warn(`⚠️ [EngineCut] Watcher already active for vehicle ${vehicleId} — skipping`);
        return;
    }

    logger.info(`🔍 [EngineCut] Starting speed watcher for vehicle ${vehicleId} (${vehicleName})`);

    // Resolve GPS device info once
    const gpsInfo = await resolveVehicleGps(vehicleId);
    if (!gpsInfo) {
        logger.error(`❌ [EngineCut] Cannot resolve GPS info for vehicle ${vehicleId} — aborting watcher`);
        return;
    }

    const { mac_id_gps, account_name } = gpsInfo;
    const watchStartTime = Date.now();

    // ── Interval tick ─────────────────────────────────────────────────────────
    const intervalId = setInterval(async () => {
        try {
            // Check timeout first
            const elapsedMs = Date.now() - watchStartTime;
            if (elapsedMs >= MAX_WATCH_MS) {
                logger.warn(
                    `⏰ [EngineCut] Timeout reached (${MAX_WATCH_MINUTES}min) for vehicle ${vehicleId}. ` +
                    `Engine NOT cut. Stopping watcher.`
                );
                stopWatcher(vehicleId);

                // Notify partner that the cut could not be executed
                if (partnerId) {
                    await safeSendNotification(
                        partnerId,
                        '⚠️ Engine Cut Could Not Be Executed',
                        `Vehicle ${vehicleName} remained at high speed for over ${MAX_WATCH_MINUTES} minutes after leaving the zone. Engine was not cut automatically. Please take manual action.`,
                        {
                            type:       'geofence_cut_timeout',
                            vehicleId:  String(vehicleId),
                            vehicleName
                        }
                    );
                }
                return;
            }

            // Read current speed from DB
            const speed = await getCurrentSpeed(mac_id_gps);

            if (speed === null) {
                logger.warn(`⚠️ [EngineCut] Could not read speed for vehicle ${vehicleId} — will retry`);
                return; // retry next tick
            }

            logger.info(
                `🏎️ [EngineCut] vehicle=${vehicleId} speed=${speed} km/h ` +
                `(threshold=${SPEED_CUT_THRESHOLD_KMH}) elapsed=${Math.round(elapsedMs / 1000)}s`
            );

            if (speed >= SPEED_CUT_THRESHOLD_KMH) {
                // Still too fast — keep watching
                return;
            }

            // ── Speed is below threshold — send CLOSERELAY ────────────────────
            logger.warn(
                `🔴 [EngineCut] speed=${speed} < ${SPEED_CUT_THRESHOLD_KMH} — ` +
                `${CUTOFF_EXECUTION_ENABLED ? 'sending' : 'SIMULATING (GEOFENCE_CUTOFF_EXECUTION_ENABLED=false)'} ` +
                `CLOSERELAY to vehicle ${vehicleId}`
            );
            stopWatcher(vehicleId); // stop polling immediately before async work

            const cmdResult = CUTOFF_EXECUTION_ENABLED
                ? await sendGpsCommandWithFallback({
                    accountName: String(account_name).trim().toLowerCase(),
                    macId:       mac_id_gps,
                    command:     'CLOSERELAY',
                })
                : {
                    ok:           true,
                    message:      'SIMULATED — GEOFENCE_CUTOFF_EXECUTION_ENABLED is not "true"',
                    providerResp: null,
                    retried:      false,
                    simulated:    true,
                };

            if (cmdResult.ok && cmdResult.simulated) {
                // Simulation mode: prove the trigger logic works end-to-end without
                // sending a real command or telling driver/partner the engine is off
                // when it isn't.
                logger.info(`🧪 [EngineCut] SIMULATED CLOSERELAY for vehicle ${vehicleId} (speed=${speed}km/h) — no real command sent, no user notified`);

            } else if (cmdResult.ok) {
                logger.info(`✅ [EngineCut] CLOSERELAY succeeded for vehicle ${vehicleId}`);

                // Mark in DB
                await markGeofenceLocked(vehicleId);

                // Notify driver
                const { driverId } = await resolveVehicleUsers(vehicleId);
                if (driverId) {
                    await safeSendNotification(
                        driverId,
                        '🔴 Engine Disabled',
                        `The engine of ${vehicleName} has been turned off because you left the authorized zone. Contact your fleet manager to re-enable it.`,
                        {
                            type:       'geofence_engine_cut',
                            vehicleId:  String(vehicleId),
                            vehicleName
                        }
                    );
                }

                // Notify partner
                if (partnerId) {
                    await safeSendNotification(
                        partnerId,
                        '🔴 Engine Cut Executed',
                        `Vehicle ${vehicleName} engine has been automatically disabled (speed dropped to ${speed} km/h outside the zone).`,
                        {
                            type:       'geofence_engine_cut',
                            vehicleId:  String(vehicleId),
                            vehicleName,
                            speed:      String(speed)
                        }
                    );
                }

            } else {
                // Command failed — log and notify partner
                logger.error(
                    `❌ [EngineCut] CLOSERELAY FAILED for vehicle ${vehicleId}: ${cmdResult.message}`
                );

                if (partnerId) {
                    await safeSendNotification(
                        partnerId,
                        '❌ Engine Cut Failed',
                        `Attempted to cut engine of ${vehicleName} (speed ${speed} km/h) but the GPS command failed. Please take manual action.`,
                        {
                            type:       'geofence_cut_failed',
                            vehicleId:  String(vehicleId),
                            vehicleName,
                            error:      cmdResult.message || 'Unknown error'
                        }
                    );
                }
            }

        } catch (err) {
            logger.error(`❌ [EngineCut] Interval tick error for vehicle ${vehicleId}: ${err.message}`);
            // Don't stop watcher on transient errors — keep trying
        }
    }, POLL_INTERVAL_MS);

    activeWatchers.set(vehicleId, intervalId);
    logger.info(
        `⏱️ [EngineCut] Watcher registered for vehicle ${vehicleId}. ` +
        `Will poll every ${POLL_INTERVAL_MS / 1000}s for up to ${MAX_WATCH_MINUTES}min.`
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: clear and remove a watcher
// ─────────────────────────────────────────────────────────────────────────────
const stopWatcher = (vehicleId) => {
    const intervalId = activeWatchers.get(vehicleId);
    if (intervalId) {
        clearInterval(intervalId);
        activeWatchers.delete(vehicleId);
        logger.info(`🛑 [EngineCut] Watcher stopped for vehicle ${vehicleId}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Stop watcher externally (e.g. when vehicle returns to zone)
// ─────────────────────────────────────────────────────────────────────────────
const cancelSpeedWatcher = (vehicleId) => {
    if (activeWatchers.has(vehicleId)) {
        stopWatcher(vehicleId);
        logger.info(`✅ [EngineCut] Watcher cancelled (vehicle returned to zone) for vehicle ${vehicleId}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: How many watchers are currently active (useful for monitoring)
// ─────────────────────────────────────────────────────────────────────────────
const activeWatcherCount = () => activeWatchers.size;

module.exports = {
    isLeasePartnerVehicle,
    sendGeofenceWarningNotifications,
    startSpeedWatcher,
    cancelSpeedWatcher,
    activeWatcherCount
};