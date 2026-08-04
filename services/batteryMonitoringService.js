// services/batteryMonitoringService.js
const Voiture = require('../models/voiture');
const Alert = require('../models/Alert');
const User = require('../models/userModel');
const firebaseService = require('./notificationService');
const sequelize = require('../config/database');

class BatteryMonitoringService {
    constructor() {
        // Battery alert thresholds (descending order). A level's "bucket" is
        // the smallest threshold it is <= to (e.g. 18% -> bucket 20, 3% -> bucket 5).
        this.BATTERY_THRESHOLDS = [25, 20, 15, 10, 5, 0];

        // A candidate bucket change must be seen on this many consecutive
        // readings before it's treated as real and an alert fires. This is
        // what stops a single noisy/spurious reading (voltage-sensor jitter,
        // a bad statenumber parse, etc.) from registering as a real crossing.
        // Same pattern as the geofence exit/return confirmation debounce.
        this.CONFIRM_READINGS = 3;

        // Minimum time between two alerts for the SAME vehicle regardless of
        // bucket -- defense in depth against any remaining noise source.
        this.ALERT_COOLDOWN_MS = 5 * 60 * 1000;

        // vehicleId -> { confirmedBucket, pendingBucket, pendingCount, lastAlertAt }
        // In-memory only, no DB schema change. confirmedBucket is seeded from
        // the persisted voitures.battery_level the first time a vehicle is
        // seen in this process, so a restart doesn't look like a fresh
        // "just became low" event for a vehicle that's already been low for
        // days -- that seeding is what used to be missing, and it's what
        // caused a burst of re-alerts after every process restart.
        this.vehicleState = new Map();

        // Per-vehicle lock. processBatteryLevel is called once per vehicle
        // per GPS account per fetch cycle in location.js; if a device is
        // ever double-registered across the two polled accounts (or any
        // future caller hits this concurrently), two calls for the same
        // vehicle landing close together must not be allowed to race each
        // other and both confirm/alert on the same transition.
        this.vehicleLocks = new Map();
    }

    // ✅ Only the columns that actually exist in the voitures table
    get VOITURE_ATTRIBUTES() {
        return [
            'id',
            'voiture_unique_id',
            'immatriculation',
            'mac_id_gps',
            'marque',
            'model',
            'couleur',
            'photo',
            'time_zone_start',
            'time_zone_end',
            'speed_zone',
            'region_id',
            'region_name',
            'geofence_zone',
            'nickname',
            'latitude',
            'longitude',
            'battery_level',
            'last_battery_check',
            'created_at',
            'updated_at'
        ];
    }

    withVehicleLock(vehicleId, fn) {
        const key      = String(vehicleId);
        const previous = this.vehicleLocks.get(key) || Promise.resolve();
        const run      = previous.then(fn, fn); // run fn even if the previous call in the queue failed
        this.vehicleLocks.set(key, run.catch(() => {})); // never let a rejection propagate into the next caller
        return run;
    }

    // Smallest threshold the level is <= to; null = healthy (> highest threshold).
    getBucket(level) {
        if (level === null || level === undefined || isNaN(level)) return null;
        const ascending = [...this.BATTERY_THRESHOLDS].sort((a, b) => a - b); // [0,5,10,15,20,25]
        for (const t of ascending) {
            if (level <= t) return t;
        }
        return null;
    }

    // Higher rank = healthier. null (no active low-battery bucket) ranks above every threshold.
    bucketRank(bucket) {
        return bucket === null ? Infinity : bucket;
    }

    getVehicleState(vehicleId, seedFromLevel) {
        const key = String(vehicleId);
        if (!this.vehicleState.has(key)) {
            this.vehicleState.set(key, {
                confirmedBucket: this.getBucket(seedFromLevel),
                pendingBucket:   undefined,
                pendingCount:    0,
                lastAlertAt:     null,
            });
        }
        return this.vehicleState.get(key);
    }

    /**
     * Process battery level from GPS update
     * @param {Object} gpsData - GPS data containing statenumber field
     * @param {string} macId - Vehicle MAC ID
     */
    async processBatteryLevel(gpsData, macId) {
        try {
            const batteryLevel = this.extractBatteryLevel(gpsData);
            if (batteryLevel === null) return;

            const vehicle = await Voiture.findOne({
                where: { mac_id_gps: macId },
                attributes: this.VOITURE_ATTRIBUTES
            });
            if (!vehicle) return;

            await this.withVehicleLock(vehicle.id, async () => {
                // Seed confirmed bucket from the persisted level the first time
                // this vehicle is seen in this process (restart-safe) -- must
                // happen before .update() below overwrites the in-memory value.
                const state = this.getVehicleState(vehicle.id, vehicle.battery_level);

                await vehicle.update({
                    battery_level: batteryLevel,
                    last_battery_check: new Date()
                });

                const candidateBucket = this.getBucket(batteryLevel);

                if (candidateBucket === state.confirmedBucket) {
                    // Matches confirmed state -- clear any in-progress pending change.
                    state.pendingBucket = undefined;
                    state.pendingCount = 0;
                    return;
                }

                if (candidateBucket === state.pendingBucket) {
                    state.pendingCount += 1;
                } else {
                    state.pendingBucket = candidateBucket;
                    state.pendingCount = 1;
                }

                if (state.pendingCount < this.CONFIRM_READINGS) {
                    return; // not confirmed yet -- could be a transient/noisy reading
                }

                // Confirmed: this candidate bucket has now been seen on
                // CONFIRM_READINGS consecutive readings. Fire exactly ONE
                // alert for this transition (not one per threshold skipped
                // over on the way), then move on.
                const previousBucket = state.confirmedBucket;
                const direction = this.bucketRank(candidateBucket) < this.bucketRank(previousBucket) ? 'low' : 'recovery';

                state.confirmedBucket = candidateBucket;
                state.pendingBucket = undefined;
                state.pendingCount = 0;

                // Threshold to report: the bucket just entered, or -- when
                // recovering all the way past every threshold (candidateBucket
                // is null) -- the last threshold it was below, so the message
                // still reads "recovered above X%" instead of a blank value.
                const reportedThreshold = candidateBucket !== null ? candidateBucket : previousBucket;
                if (reportedThreshold === null) return; // was already healthy, nothing to report

                if (state.lastAlertAt && (Date.now() - state.lastAlertAt) < this.ALERT_COOLDOWN_MS) {
                    console.log(`⏳ Battery alert cooldown active for vehicle ${vehicle.id}, skipping notification (state already updated)`);
                    return;
                }

                await this.createBatteryAlert(vehicle, batteryLevel, reportedThreshold, direction, gpsData);
                state.lastAlertAt = Date.now();
            });

        } catch (error) {
            console.error('🔥 Error processing battery level:', error);
            console.error('🔥 Stack trace:', error.stack);
        }
    }

    /**
     * Extract battery percentage from statenumber field
     * @param {Object} gpsData - GPS data object
     * @returns {number|null} Battery percentage or null if not found
     */
    extractBatteryLevel(gpsData) {
        try {
            const statenumber = gpsData.statenumber || gpsData.StateNumber;
            if (!statenumber) return null;

            const values = statenumber.split(',');
            if (values.length < 5) return null;

            const batteryValue = parseFloat(values[4]);
            if (isNaN(batteryValue)) return null;

            let batteryPercentage;
            if (batteryValue < 100) {
                batteryPercentage = batteryValue;
            } else {
                // NOTE: this voltage-decoding branch (and its boundary right at
                // 100) has not been verified against a raw device sample. If
                // devices intermittently report a value on the wrong side of
                // that boundary, this can itself produce a spurious high/low
                // reading -- the CONFIRM_READINGS debounce above is the
                // safety net for that, but if spurious readings keep showing
                // up in the logs this formula is the next place to check.
                const voltage = batteryValue - 100;
                batteryPercentage = Math.max(0, Math.min(100, ((voltage - 11.8) / (12.6 - 11.8)) * 100));
            }

            return Math.round(batteryPercentage);
        } catch (error) {
            console.error('🔥 Error extracting battery level:', error);
            return null;
        }
    }

    /**
     * Create battery alert and send notification. Cooldown/dedup is handled
     * by the caller's ephemeral per-vehicle state (see processBatteryLevel) --
     * by the time this runs, the crossing has already been confirmed.
     */
    async createBatteryAlert(vehicle, batteryLevel, threshold, direction, gpsData) {
        try {
            const alertType = direction === 'recovery' ? 'battery_recovery' : 'low_battery';

            const [user] = await sequelize.query(`
                SELECT u.*
                FROM users u
                INNER JOIN association_user_voitures auv ON u.id = auv.user_id
                WHERE auv.voiture_id = ?
                LIMIT 1
            `, {
                replacements: [vehicle.id],
                type: sequelize.QueryTypes.SELECT
            });

            if (!user) {
                console.log(`❌ No user found for vehicle ${vehicle.id}`);
                return;
            }

            const message = this.getAlertMessage(vehicle.nickname, batteryLevel, threshold, direction);
            const title = direction === 'recovery' ? 'Battery Recovering' : 'Low Battery Warning';
            const severity = this.getSeverity(threshold, direction);
            const emoji = direction === 'recovery' ? '🔋✅' : '🔋⚠️';

            const latitude = gpsData.weidu || gpsData.latitude || null;
            const longitude = gpsData.jingdu || gpsData.longitude || null;

            const alert = await Alert.create({
                voiture_id: vehicle.id,
                alert_type: alertType,
                message: message,
                alert_status: 'ACTIVE',
                latitude: latitude,
                longitude: longitude,
                alerted_at: new Date(),
                read: false,
                metadata: JSON.stringify({
                    battery_level: batteryLevel,
                    threshold: threshold,
                    direction: direction,
                    severity: severity
                })
            });

            console.log(`✅ ${emoji} Battery alert saved to database with ID: ${alert.id} (vehicle ${vehicle.id}, ${direction} @ ${threshold}%)`);

            if (user.fcm_token) {
                await firebaseService.sendNotification(
                    user.fcm_token,
                    title,
                    message,
                    {
                        type: alertType,
                        severity: severity,
                        vehicleId: vehicle.id.toString(),
                        alertId: alert.id.toString(),
                        batteryLevel: batteryLevel.toString(),
                        threshold: threshold.toString(),
                        latitude: latitude ? latitude.toString() : '',
                        longitude: longitude ? longitude.toString() : ''
                    }
                );
            }

        } catch (error) {
            console.error('🔥 Error creating battery alert:', error);
            console.error('🔥 Error details:', error.message);
        }
    }

    /**
     * Generate alert message based on battery level and direction
     */
    getAlertMessage(vehicleName, batteryLevel, threshold, direction) {
        if (direction === 'recovery') {
            return `Battery recovering for ${vehicleName}. Battery level is now ${batteryLevel}% (above ${threshold}% threshold)`;
        }

        if (threshold === 0) {
            return `🚨 CRITICAL: ${vehicleName} battery is DEAD (${batteryLevel}%)! Device may shut down soon!`;
        } else if (threshold <= 5) {
            return `🚨 URGENT: ${vehicleName} battery critically low at ${batteryLevel}%! Charge immediately!`;
        } else if (threshold <= 10) {
            return `⚠️ WARNING: ${vehicleName} battery very low at ${batteryLevel}%. Please charge soon.`;
        } else if (threshold <= 15) {
            return `⚠️ ${vehicleName} battery running low at ${batteryLevel}%. Consider charging.`;
        } else {
            return `🔋 ${vehicleName} battery at ${batteryLevel}%. Below ${threshold}% threshold.`;
        }
    }

    /**
     * Get severity level based on threshold
     */
    getSeverity(threshold, direction) {
        if (direction === 'recovery') return 'info';
        if (threshold === 0) return 'critical';
        if (threshold <= 5) return 'critical';
        if (threshold <= 10) return 'high';
        if (threshold <= 15) return 'medium';
        return 'warning';
    }

    /**
     * Clear tracked state for a vehicle (e.g. on manual reset)
     */
    clearCache(vehicleId) {
        this.vehicleState.delete(String(vehicleId));
        console.log(`🗑️ Battery state cleared for vehicle ${vehicleId}`);
    }

    /**
     * Get the currently confirmed battery bucket for a vehicle (null = healthy, or a threshold value)
     */
    getCachedLevel(vehicleId) {
        const state = this.vehicleState.get(String(vehicleId));
        return state ? state.confirmedBucket : undefined;
    }
}

module.exports = new BatteryMonitoringService();
