// jobs/checkSecurityMovement.js
const cron = require('node-cron');
const geolib = require('geolib');

const VehicleSecurity = require('../models/vehicleSecurity');
const Location = require('../models/location');
const Voiture = require('../models/voiture');

// === Config ===
const MOVE_THRESHOLD_METERS = Number(process.env.SECURITY_MOVE_THRESHOLD ?? 5); // alert if moved >= 5m
const COOLDOWN_SECONDS = Number(process.env.SECURITY_ALARM_COOLDOWN ?? 60);     // don't spam

// In-memory throttle to avoid spamming recipients
const lastAlertAt = new Map(); // key: vehicleId, val: Date.now()

/**
 * Start the periodic security movement job.
 * Dependency-injects socket.io instance to avoid circular imports.
 *
 * @param {import('socket.io').Server} io
 * @returns {import('node-cron').ScheduledTask} the scheduled task (so you can stop it if needed)
 */
function startSecurityMovementJob(io) {
    if (!io || typeof io.to !== 'function') {
        console.warn('[checkSecurityMovement] ⚠️ io was not provided or invalid. Alerts will be logged only.');
    }

    // Run every 15 seconds
    const task = cron.schedule('*/15 * * * * *', async () => {
        console.log('🔍 Running security check...');

        let activeSecurities;
        try {
            activeSecurities = await VehicleSecurity.findAll({ where: { is_active: true } });
        } catch (err) {
            console.error('[checkSecurityMovement] Failed to load active securities:', err);
            return;
        }

        for (const security of activeSecurities) {
            try {
                const voiture = await Voiture.findByPk(security.voiture_id);
                if (!voiture) {
                    console.warn(`[checkSecurityMovement] Vehicle not found for security id=${security.id}`);
                    continue;
                }

                // Latest location for this vehicle (by its GPS MAC)
                const latestLocation = await Location.findOne({
                    where: { mac_id_gps: voiture.mac_id_gps },
                    order: [['datetime', 'DESC']],
                });

                if (!latestLocation) {
                    // No location yet — nothing to evaluate
                    continue;
                }

                // Compute movement distance from parked point to latest point
                const distance = geolib.getDistance(
                    { latitude: Number(security.parked_latitude), longitude: Number(security.parked_longitude) },
                    { latitude: Number(latestLocation.latitude), longitude: Number(latestLocation.longitude) }
                );

                console.log(`🚨 Vehicle ${voiture.id} moved: ${distance}m`);

                if (Number.isFinite(distance) && distance >= MOVE_THRESHOLD_METERS) {
                    // Throttle alerts per vehicle
                    const now = Date.now();
                    const last = lastAlertAt.get(voiture.id) ?? 0;
                    if ((now - last) / 1000 < COOLDOWN_SECONDS) {
                        // Skip: still in cooldown
                        continue;
                    }
                    lastAlertAt.set(voiture.id, now);

                    await triggerSecurityAlarm({ io, voiture, distance });
                }
            } catch (error) {
                console.error(`Error checking security for vehicle ${security.voiture_id}:`, error);
            }
        }
    });

    return task;
}

/**
 * Emit a socket alert (and log fallback).
 */
async function triggerSecurityAlarm({ io, voiture, distance }) {
    const plate = voiture?.immatriculation ?? voiture?.matricule ?? `#${voiture?.id ?? 'unknown'}`;
    const payload = {
        title: '🚨 Security Alert',
        message: `Your vehicle ${plate} moved ${distance} meters from parked location.`,
        vehicleId: voiture?.id,
        distance,
        timestamp: new Date(),
    };

    console.log(`🔔 Alarm! Vehicle ${plate} moved ${distance} meters!`);

    // Emit to a per-vehicle room and a global channel (if io is available)
    try {
        if (io && typeof io.to === 'function') {
            io.to(`vehicle_${voiture.id}`).emit('securityAlarm', payload);
            io.emit('securityAlarmGlobal', payload); // optional: a global stream
        } else {
            console.warn('[triggerSecurityAlarm] io not available; only logging the alert:', payload);
        }
    } catch (err) {
        console.error('[triggerSecurityAlarm] Failed to emit via socket:', err);
    }
}

module.exports = {
    startSecurityMovementJob,
};
