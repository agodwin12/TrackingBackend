
const sequelize              = require('../config/database');
const { sendGpsCommandWithFallback, getRealtimeStatusByMacWithFallback } = require('./GpsService');
const notificationController = require('../controllers/notificationController');
const Command                = require('../models/Command');
const logger                 = require('../utils/logger');

// ── tuneable constants ────────────────────────────────────────────────────────
const SPEED_CUT_THRESHOLD_KMH = 15;   // cut engine when speed drops below this
const POLL_INTERVAL_MS        = 8000; // check speed every 8 seconds
const MAX_WATCH_MINUTES       = 10;   // give up after 10 minutes
const MAX_WATCH_MS            = MAX_WATCH_MINUTES * 60 * 1000;

// After sending CLOSERELAY, the GPS provider's "success" only means the
// platform accepted the command — not that the device actually received it
// and opened the relay. These control the post-send verification poll that
// closes that gap.
const VERIFY_POLL_ATTEMPTS      = 4;
const VERIFY_POLL_INTERVAL_MS   = 6000;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: extract the GPS provider's own command reference number
// from its response, so the audit trail has a real, provider-side ID to
// trace — not just our locally-generated placeholder. Mirrors the same
// helper in controllers/recouvrementStolenController.js.
// ─────────────────────────────────────────────────────────────────────────────
const extractCmdNo = (providerResp) => {
    if (Array.isArray(providerResp?.data) && providerResp.data.length > 0) {
        return providerResp.data[0]?.CmdNo || null;
    }
    return null;
};

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: after sending CLOSERELAY, poll the device's real state
// (not the provider's "command accepted" ack) to confirm the relay actually
// opened. Returns 'engine_confirmed_off' | 'engine_still_on' | 'no_response'.
// ─────────────────────────────────────────────────────────────────────────────
const verifyEngineCut = async (macIdGps, accountName) => {
    let gotAnyResponse = false;

    for (let attempt = 1; attempt <= VERIFY_POLL_ATTEMPTS; attempt++) {
        await sleep(VERIFY_POLL_INTERVAL_MS);

        try {
            const result = await getRealtimeStatusByMacWithFallback({ accountName, macId: macIdGps });

            if (result.success && result.status && typeof result.status.oilState === 'boolean') {
                gotAnyResponse = true;
                logger.info(
                    `🔎 [EngineCut] verify attempt ${attempt}/${VERIFY_POLL_ATTEMPTS} for MAC=${macIdGps}: ` +
                    `oilState=${result.status.oilState} (true=relay connected/engine can run, false=cut)`
                );

                if (result.status.oilState === false) {
                    return 'engine_confirmed_off';
                }
                // oilState still true — device confirmed it did NOT cut yet, keep polling
            } else {
                logger.warn(`⚠️ [EngineCut] verify attempt ${attempt}/${VERIFY_POLL_ATTEMPTS} for MAC=${macIdGps}: no usable status (${result.message || 'unknown'})`);
            }
        } catch (err) {
            logger.error(`❌ [EngineCut] verify attempt ${attempt}/${VERIFY_POLL_ATTEMPTS} error: ${err.message}`);
        }
    }

    return gotAnyResponse ? 'engine_still_on' : 'no_response';
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
const startSpeedWatcher = async (vehicleId, vehicleName, partnerId, alertId = null) => {

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
        try {
            await Command.create({
                user_id:           partnerId || null,
                employe_id:        null,
                vehicule_id:       vehicleId,
                CmdNo:             `LOCAL-${Date.now()}-${vehicleId}`,
                status:            'failed',
                type_commande:     'COUPURE',
                trigger_source:    'geofence_auto',
                trigger_alert_id:  alertId,
                provider_response: { error: 'gps_info_not_found' },
                verification_result: 'skipped_not_ok'
            });
        } catch (dbErr) {
            logger.error(`⚠️ [EngineCut] Failed to log aborted watcher for vehicle ${vehicleId}: ${dbErr.message}`);
        }
        return;
    }

    const { mac_id_gps, account_name } = gpsInfo;
    const normalizedAccount = String(account_name).trim().toLowerCase();
    const watchStartTime = Date.now();

    // ── Audit trail: one pending row per cutoff attempt, updated as it ─────────
    // progresses. This is what lets us answer "was it actually sent, and did
    // it actually work" after the fact instead of only having the coarse
    // vehicle_security.geofence_locked flag (which carries no history).
    let commandRecord;
    try {
        commandRecord = await Command.create({
            user_id:          partnerId || null,
            employe_id:       null,
            vehicule_id:      vehicleId,
            CmdNo:            `LOCAL-${Date.now()}-${vehicleId}`,
            status:           'pending',
            type_commande:    'COUPURE',
            trigger_source:   'geofence_auto',
            trigger_alert_id: alertId
        });
    } catch (dbErr) {
        logger.error(`⚠️ [EngineCut] Failed to create pending command row for vehicle ${vehicleId}: ${dbErr.message}`);
        // Don't abort the actual cutoff attempt just because the audit row failed
    }

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

                if (commandRecord) {
                    await commandRecord.update({ status: 'timeout', verification_result: 'skipped_not_ok' }).catch(() => {});
                }

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

            const sentAt = new Date();
            if (commandRecord) {
                await commandRecord.update({ sent_at: sentAt, speed_at_send: speed }).catch(() => {});
            }

            const cmdResult = CUTOFF_EXECUTION_ENABLED
                ? await sendGpsCommandWithFallback({
                    accountName: normalizedAccount,
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

            if (commandRecord) {
                await commandRecord.update({
                    CmdNo:              extractCmdNo(cmdResult.providerResp) || commandRecord.CmdNo,
                    status:             cmdResult.simulated ? 'simulated' : (cmdResult.ok ? 'sent' : 'failed'),
                    provider_response:  cmdResult.providerResp
                }).catch(() => {});
            }

            if (cmdResult.ok && cmdResult.simulated) {
                // Simulation mode: prove the trigger logic works end-to-end without
                // sending a real command or telling driver/partner the engine is off
                // when it isn't.
                logger.info(`🧪 [EngineCut] SIMULATED CLOSERELAY for vehicle ${vehicleId} (speed=${speed}km/h) — no real command sent, no user notified`);
                if (commandRecord) {
                    await commandRecord.update({ verification_result: 'skipped_simulated' }).catch(() => {});
                }

            } else if (cmdResult.ok) {
                logger.info(`✅ [EngineCut] CLOSERELAY accepted by provider for vehicle ${vehicleId} — verifying actual device state before declaring success`);

                // The provider ack only means "command accepted" — confirm the
                // relay actually opened before telling anyone the engine is off.
                const verification = await verifyEngineCut(mac_id_gps, normalizedAccount);
                if (commandRecord) {
                    await commandRecord.update({
                        verified_at:          new Date(),
                        verification_result:  verification,
                        status:               verification === 'engine_confirmed_off' ? 'confirmed_cut' : 'cut_not_confirmed'
                    }).catch(() => {});
                }

                if (verification === 'engine_confirmed_off') {
                    logger.info(`✅ [EngineCut] Engine cut CONFIRMED for vehicle ${vehicleId}`);

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
                    // Provider accepted the command but the device never confirmed
                    // the relay actually opened — do NOT tell driver/partner the
                    // engine is off, and do NOT mark geofence_locked, since it isn't
                    // verified. Surface this clearly instead of a false "success".
                    logger.error(
                        `❌ [EngineCut] CLOSERELAY accepted by provider but NOT CONFIRMED on device for vehicle ${vehicleId} ` +
                        `(verification=${verification})`
                    );

                    if (partnerId) {
                        await safeSendNotification(
                            partnerId,
                            '⚠️ Engine Cut Sent But Not Confirmed',
                            `Vehicle ${vehicleName} (speed ${speed} km/h) was sent an engine cut command, but the device did not confirm it took effect. Please verify manually.`,
                            {
                                type:       'geofence_cut_unconfirmed',
                                vehicleId:  String(vehicleId),
                                vehicleName,
                                speed:      String(speed),
                                verification
                            }
                        );
                    }
                }

            } else {
                // Command failed — log and notify partner
                logger.error(
                    `❌ [EngineCut] CLOSERELAY FAILED for vehicle ${vehicleId}: ${cmdResult.message}`
                );
                if (commandRecord) {
                    await commandRecord.update({ verification_result: 'skipped_not_ok' }).catch(() => {});
                }

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

    activeWatchers.set(vehicleId, { intervalId, commandRecord });
    logger.info(
        `⏱️ [EngineCut] Watcher registered for vehicle ${vehicleId}. ` +
        `Will poll every ${POLL_INTERVAL_MS / 1000}s for up to ${MAX_WATCH_MINUTES}min.`
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: clear and remove a watcher
// ─────────────────────────────────────────────────────────────────────────────
const stopWatcher = (vehicleId) => {
    const entry = activeWatchers.get(vehicleId);
    if (entry) {
        clearInterval(entry.intervalId);
        activeWatchers.delete(vehicleId);
        logger.info(`🛑 [EngineCut] Watcher stopped for vehicle ${vehicleId}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Stop watcher externally (e.g. when vehicle returns to zone)
// ─────────────────────────────────────────────────────────────────────────────
const cancelSpeedWatcher = (vehicleId) => {
    const entry = activeWatchers.get(vehicleId);
    if (entry) {
        stopWatcher(vehicleId);
        // The watcher never got to send anything — close out the pending
        // audit row instead of leaving it stuck at 'pending' forever.
        if (entry.commandRecord) {
            entry.commandRecord
                .update({ status: 'cancelled_vehicle_returned', verification_result: 'skipped_not_ok' })
                .catch((err) => logger.error(`⚠️ [EngineCut] Failed to close cancelled command row for vehicle ${vehicleId}: ${err.message}`));
        }
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