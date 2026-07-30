
const sequelize              = require('../config/database');
const { sendGpsCommandWithFallback, getRealtimeStatusByMacWithFallback } = require('./GpsService');
const notificationController = require('../controllers/notificationController');
const Command                = require('../models/Command');
const logger                 = require('../utils/logger');

// ── tuneable constants ────────────────────────────────────────────────────────
// No speed gate: per fleet policy, a lease-partner vehicle is cut off
// immediately on a confirmed geofence exit, regardless of current speed.

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


const activeCutoffs = new Map(); // vehicleId -> true, while a cutoff attempt is in flight

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
            '⚠️ Zone Alert — Engine Being Disabled',
            `You have left the authorized zone. The engine of ${vehicleName} is being turned off now.`,
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
            `Vehicle ${vehicleName} has left the authorized zone at ${locationName}. Engine cut is being executed now.`,
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
// PUBLIC: Immediately cut the engine for a lease-partner vehicle that just
// confirmed a geofence exit. No speed gate — sends CLOSERELAY right away
// regardless of current speed, per fleet policy. One attempt per vehicle at
// a time (a duplicate call while one is already in flight is ignored).
// ─────────────────────────────────────────────────────────────────────────────
const startSpeedWatcher = async (vehicleId, vehicleName, partnerId, alertId = null) => {

    if (activeCutoffs.has(vehicleId)) {
        logger.warn(`⚠️ [EngineCut] Cutoff already in progress for vehicle ${vehicleId} — skipping`);
        return;
    }
    activeCutoffs.set(vehicleId, true);

    try {
        logger.warn(`🔴 [EngineCut] Executing immediate geofence cutoff for vehicle ${vehicleId} (${vehicleName}) — no speed gate`);

        // Resolve GPS device info
        const gpsInfo = await resolveVehicleGps(vehicleId);
        if (!gpsInfo) {
            logger.error(`❌ [EngineCut] Cannot resolve GPS info for vehicle ${vehicleId} — aborting cutoff`);
            try {
                await Command.create({
                    user_id:           partnerId || null,
                    employe_id:        null,
                    vehicule_id:       vehicleId,
                    CmdNo:             `LOCAL-${Date.now()}-${vehicleId}`,
                    status:            'failed',
                    type_commande:     'COUPURE',
                    trigger_source:    'geofence_auto',
                    description:       'Geofence violation - recorded by System Admin',
                    trigger_alert_id:  alertId,
                    provider_response: { error: 'gps_info_not_found' },
                    verification_result: 'skipped_not_ok'
                });
            } catch (dbErr) {
                logger.error(`⚠️ [EngineCut] Failed to log aborted cutoff for vehicle ${vehicleId}: ${dbErr.message}`);
            }
            return;
        }

        const { mac_id_gps, account_name } = gpsInfo;
        const normalizedAccount = String(account_name).trim().toLowerCase();
        const speed = await getCurrentSpeed(mac_id_gps); // logged for the audit trail only — not gated on

        // ── Audit trail: one row per cutoff attempt. This is what lets us
        // answer "was it actually sent, and did it actually work" after the
        // fact instead of only having the coarse vehicle_security.geofence_locked
        // flag (which carries no history).
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
                description:      'Geofence violation - recorded by System Admin',
                trigger_alert_id: alertId,
                speed_at_send:    speed,
                sent_at:          new Date()
            });
        } catch (dbErr) {
            logger.error(`⚠️ [EngineCut] Failed to create pending command row for vehicle ${vehicleId}: ${dbErr.message}`);
            // Don't abort the actual cutoff attempt just because the audit row failed
        }

        logger.warn(
            `🔴 [EngineCut] ${CUTOFF_EXECUTION_ENABLED ? 'Sending' : 'SIMULATING (GEOFENCE_CUTOFF_EXECUTION_ENABLED=false)'} ` +
            `CLOSERELAY to vehicle ${vehicleId} (speed=${speed ?? 'unknown'}km/h)`
        );

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
            logger.info(`🧪 [EngineCut] SIMULATED CLOSERELAY for vehicle ${vehicleId} — no real command sent, no user notified`);
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

                await markGeofenceLocked(vehicleId);

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

                if (partnerId) {
                    await safeSendNotification(
                        partnerId,
                        '🔴 Engine Cut Executed',
                        `Vehicle ${vehicleName} engine has been automatically disabled after leaving the authorized zone.`,
                        {
                            type:       'geofence_engine_cut',
                            vehicleId:  String(vehicleId),
                            vehicleName,
                            speed:      String(speed ?? '')
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
                        `Vehicle ${vehicleName} was sent an engine cut command, but the device did not confirm it took effect. Please verify manually.`,
                        {
                            type:       'geofence_cut_unconfirmed',
                            vehicleId:  String(vehicleId),
                            vehicleName,
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
                    `Attempted to cut engine of ${vehicleName} but the GPS command failed. Please take manual action.`,
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
        logger.error(`❌ [EngineCut] startSpeedWatcher error for vehicle ${vehicleId}: ${err.message}`);
    } finally {
        activeCutoffs.delete(vehicleId);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Kept for call-site compatibility (geofenceMonitorController calls
// this when a vehicle's return to zone is confirmed). Since cutoff is now
// immediate rather than speed-gated, there's no pending watcher to abort by
// the time a return is confirmed — this is a no-op safety valve, not an
// active cancellation.
// ─────────────────────────────────────────────────────────────────────────────
const cancelSpeedWatcher = (vehicleId) => {
    if (activeCutoffs.has(vehicleId)) {
        logger.info(`ℹ️ [EngineCut] Vehicle ${vehicleId} returned to zone while its cutoff attempt was still in flight (verification poll) — letting it finish.`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: How many cutoffs are currently in flight (useful for monitoring)
// ─────────────────────────────────────────────────────────────────────────────
const activeWatcherCount = () => activeCutoffs.size;

module.exports = {
    isLeasePartnerVehicle,
    sendGeofenceWarningNotifications,
    startSpeedWatcher,
    cancelSpeedWatcher,
    activeWatcherCount
};