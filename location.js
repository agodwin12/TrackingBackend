// location.js - GPS TRACKING SERVICE (Multi-Account + Socket.IO + Safe Zone + Geofence + Speed + Time Zone + Device Alarms + Battery Monitoring)
const axios = require('axios');
const mysql = require('mysql2/promise');
const cacheInvalidationService = require('./services/cacheInvalidationService');
const socketService = require('./services/socketService');
const { checkSafeZoneViolation } = require('./controllers/safeZoneController');
const { checkGeofenceViolation } = require('./controllers/geofenceMonitorController');
const SpeedAlertService = require('./services/speedAlertService');
const TimeZoneAlertService = require('./services/timeZoneAlertService');
const DeviceAlertService = require('./services/deviceAlertService');
const BatteryMonitoringService = require('./services/batteryMonitoringService');
const logger = require('./utils/logger');
require('dotenv').config();

// ========== COORDINATE HANDLING ==========
// 18gps returns TRUE WGS84 for our Cameroon devices — empirically confirmed by
// map-testing the raw API coordinate against the physical location of the moto.
// Therefore NO datum conversion is applied. The previous GCJ-02→WGS84 step was
// shoving every point ~1.5 km off (that offset only exists inside mainland China)
// and has been removed. ⛔ DO NOT re-introduce any GCJ-02 / BD-09 conversion here.

// ========== SPEED SANITY FILTER ==========
// Persists across fetch cycles. Keyed by mac_id_gps.
const lastKnownPositions = new Map();

// ========== MAC ID FORMAT VALIDATION ==========
// Real GPS device IDs from our provider are numeric strings of at least 15
// digits (e.g. "863957076523494"). A handful of vehicles carry old/placeholder
// 4-digit mac_id_gps values instead of a real device ID -- reject their
// records here so nothing ever lands in `locations` for them, and nothing
// downstream (including the app) can ever fetch location data for a vehicle
// that was never validly identified in the first place.
const MIN_MAC_ID_DIGITS = 15;

function isValidMacIdFormat(macIdGps) {
    const str = String(macIdGps);
    return /^\d+$/.test(str) && str.length >= MIN_MAC_ID_DIGITS;
}

// ========== VEHICLE INFO CACHE ==========
// Persists across fetch cycles, like lastKnownPositions. Avoids re-querying
// voitures (id, model, nickname) for every vehicle on every 10s cycle --
// this data essentially never changes at runtime. A short TTL still lets an
// admin reassigning a mac_id_gps to a different vehicle take effect within
// a few minutes instead of requiring a server restart.
const vehicleInfoCache = new Map();
const VEHICLE_INFO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getVehicleInfo(connection, macIdGps) {
    const cached = vehicleInfoCache.get(macIdGps);
    if (cached && (Date.now() - cached.cachedAt) < VEHICLE_INFO_CACHE_TTL_MS) {
        return cached;
    }

    try {
        const [rows] = await connection.execute(
            'SELECT id, model, nickname FROM voitures WHERE mac_id_gps = ? LIMIT 1',
            [macIdGps]
        );
        const info = rows.length > 0
            ? { id: rows[0].id, model: rows[0].model, nickname: rows[0].nickname, cachedAt: Date.now() }
            : { id: null, model: null, nickname: null, cachedAt: Date.now() };
        vehicleInfoCache.set(macIdGps, info);
        return info;
    } catch (e) {
        logger.error(`❌ Failed to resolve vehicle info for MAC ${macIdGps}:`, e.message);
        return cached || { id: null, model: null, nickname: null, cachedAt: 0 };
    }
}

// Same as getVehicleInfo, but borrows its own short-lived pool connection on
// a cache miss instead of requiring one to be passed in. Used by alert
// processing once it's been detached from the position-save cycle's
// connection lifecycle -- that connection may already be back in the pool
// (and reused by something else) by the time alert processing runs.
async function getVehicleInfoAuto(macIdGps) {
    const cached = vehicleInfoCache.get(macIdGps);
    if (cached && (Date.now() - cached.cachedAt) < VEHICLE_INFO_CACHE_TTL_MS) {
        return cached;
    }

    let connection = null;
    try {
        connection = await getPoolConnection();
        return await getVehicleInfo(connection, macIdGps);
    } finally {
        if (connection) connection.release();
    }
}

// ========== CONCURRENT FETCH GUARD ==========
// Prevents cycles from stacking if one takes longer than the interval.
let isFetchingGPS = false;

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ========== MULTI-ACCOUNT GPS CONFIGURATION ==========
const GPS_ACCOUNTS = [
    {
        name: 'tracking',
        loginName: process.env.GPS_LOGIN_NAME_1 || 'Proxym_tracking',
        loginPassword: process.env.GPS_LOGIN_PASSWORD_1 || 'proxym123',
    },
    {
        name: 'mobility',
        loginName: process.env.GPS_LOGIN_NAME_2 || 'SecondAccount',
        loginPassword: process.env.GPS_LOGIN_PASSWORD_2 || 'password123',
    }
];

const GPS_CONFIG = {
    loginUrl: process.env.GPS_LOGIN_URL || 'http://appzzl.18gps.net/',
    apiUrl: process.env.GPS_API_URL || 'http://apitest.18gps.net/GetDateServices.asmx',
    fetchInterval: parseInt(process.env.GPS_FETCH_INTERVAL) || 10000,
    loginType: process.env.GPS_LOGIN_TYPE || 'ENTERPRISE',
    language: process.env.GPS_LANGUAGE || 'en',
    timeZone: parseInt(process.env.GPS_TIMEZONE) || 8,
    mapType: process.env.GPS_MAP_TYPE || 'WGS84'
};

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tracking'
};

// ========== PERSISTENT CONNECTION POOL ==========
// Created once at module load. Never destroyed during normal operation.
// Each fetch cycle borrows a connection and releases it in finally —
// no leaked connections, no "too many connections" crashes.
const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,          // unlimited queue — never throw POOL_ENQUEUELIMIT
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

pool.on('connection', () => logger.debug('🔌 New MySQL pool connection created'));
pool.on('enqueue',    () => logger.warn('⏳ MySQL pool: waiting for available connection'));

async function getPoolConnection() {
    const connection = await pool.getConnection();
    // Allow zero-date values (GPS timestamps can be 0000-00-00 00:00:00)
    await connection.query("SET SESSION sql_mode='ALLOW_INVALID_DATES';");
    return connection;
}

// ========== UTILITY FUNCTIONS ==========
function convertToDatetime(timestamp) {
    if (!timestamp || isNaN(timestamp) || Number(timestamp) === 0) {
        return '0000-00-00 00:00:00';
    }
    const ts = parseInt(timestamp);
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
        return '0000-00-00 00:00:00';
    }
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ========== GPS API FUNCTIONS ==========
async function login(loginName, loginPassword) {
    try {
        const response = await axios.get(`${GPS_CONFIG.apiUrl}/loginSystem`, {
            params: {
                LoginName: loginName,
                LoginPassword: loginPassword,
                LoginType: GPS_CONFIG.loginType,
                language: GPS_CONFIG.language,
                timeZone: GPS_CONFIG.timeZone,
                apply: 'APP',
                ISMD5: 0,
                loginUrl: GPS_CONFIG.loginUrl,
            },
            timeout: 10000
        });

        const data = response.data;

        if (data.success === 'true') {
            logger.debug('✅ Login successful');
            return { token: data.mds, userId: data.id };
        } else {
            logger.warn('❌ Login failed:', data.msg || 'User name or password error');
            return null;
        }
    } catch (error) {
        logger.error('🔥 Login API error:', error.message);
        return null;
    }
}

// ========== TOKEN CACHE ==========
// Logging in was previously done on every single fetch cycle, for both
// accounts -- an unnecessary round trip to the provider on every tick.
// Tokens are now cached per account and only refreshed when they age out
// or the provider itself reports the token as invalid/expired.
const tokenCache = new Map(); // account name -> { token, userId, obtainedAt }
const TOKEN_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes -- conservative vs. the provider's real session length

function extractErrorCode(resp) {
    if (!resp) return null;
    return resp.errorCode ?? resp.error_code ?? resp.code ?? resp.statusCode ?? null;
}

// Mirrors services/GpsService.js's isTokenInvalid() -- same provider, same response shape.
function isTokenInvalid(resp) {
    const code = extractErrorCode(resp);
    if (code === 403 || code === '403') return true;
    if (code === 401 || code === '401') return true;

    const msg = String(resp?.errorDescribe || resp?.msg || resp?.message || '').toLowerCase();
    if (msg.includes('token') && (msg.includes('invalid') || msg.includes('expire'))) return true;
    if (msg.includes('mds') && (msg.includes('invalid') || msg.includes('expire'))) return true;

    return false;
}

async function getValidToken(account, forceRefresh = false) {
    const cached = tokenCache.get(account.name);
    if (!forceRefresh && cached && (Date.now() - cached.obtainedAt) < TOKEN_CACHE_TTL_MS) {
        return cached;
    }

    const loginData = await login(account.loginName, account.loginPassword);
    if (!loginData) return null;

    const entry = { token: loginData.token, userId: loginData.userId, obtainedAt: Date.now() };
    tokenCache.set(account.name, entry);
    return entry;
}

// Runs `apiCall(token, userId)` with a cached (or freshly obtained) token.
// If the provider reports the token as invalid/expired, forces exactly one
// re-login and retries once before giving up for this tick.
async function withValidToken(account, apiCall) {
    let tokenEntry = await getValidToken(account);
    if (!tokenEntry) return null;

    let result = await apiCall(tokenEntry.token, tokenEntry.userId);

    if (result && result.tokenInvalid) {
        logger.warn(`🔑 [${account.name}] Token invalid/expired -- forcing re-login`);
        tokenEntry = await getValidToken(account, true);
        if (!tokenEntry) return null;
        result = await apiCall(tokenEntry.token, tokenEntry.userId);
    }

    if (result && result.tokenInvalid) {
        logger.error(`❌ [${account.name}] Still invalid after re-login -- giving up this cycle`);
        return null;
    }

    return result;
}

async function fetchLocations(token, userId) {
    try {
        const response = await axios.get(`${GPS_CONFIG.apiUrl}/GetDate`, {
            params: {
                method: 'getDeviceListByCustomId',
                id: userId,
                mds: token,
                mapType: GPS_CONFIG.mapType,
            },
            timeout: 10000
        });

        const data = response.data;

        if (data.success === 'true') {
            logger.debug('✅ Locations fetched successfully');
            return data;
        }

        if (isTokenInvalid(data)) return { tokenInvalid: true };

        logger.warn('❌ Failed to fetch locations:', data.errorDescribe);
        return null;
    } catch (error) {
        logger.error('🔥 Fetch locations API error:', error.message);
        return null;
    }
}

// ========== FETCH ALARM DATA ==========
async function fetchAlarmData(token, userId) {
    try {
        logger.debug('🔔 Fetching alarm data...');

        const response = await axios.get(`${GPS_CONFIG.apiUrl}/GetDate`, {
            params: {
                method: 'getCustomAlarm',
                type: 'custom',
                id: userId,
                mds: token,
                max_time: Date.now(),
                timestamp: Date.now()
            },
            timeout: 10000
        });

        const data = response.data;

        if (data.success === 'true' || data.success === true) {
            logger.debug('✅ Alarm data fetched successfully');
            logger.debug(`📊 Total alarms: ${data.total || 0}`);
            return data;
        }

        if (isTokenInvalid(data)) return { tokenInvalid: true };

        logger.debug('⚠️ No alarm data available');
        return null;
    } catch (error) {
        logger.error('🔥 Fetch alarm data error:', error.message);
        return null;
    }
}

// ========== PROCESS ALARM DATA ==========
async function processAlarmData(alarmData) {
    if (!alarmData || !alarmData.rows || alarmData.rows.length === 0) {
        logger.debug('ℹ️ No alarms to process');
        return;
    }

    logger.debug(`📊 Processing ${alarmData.rows.length} alarms...`);

    for (const alarm of alarmData.rows) {
        try {
            const typeId = parseInt(alarm.type_id);

            if (DeviceAlertService.isAlarmSupported(typeId)) {
                logger.debug(`✅ Supported device alarm detected: 0x${typeId.toString(16).toUpperCase()}`);
                await DeviceAlertService.processAlarm({
                    type_id: alarm.type_id,
                    macid: alarm.macid,
                    mac_id: alarm.macid,
                    weidu: alarm.weidu,
                    jingdu: alarm.jingdu,
                    latitude: alarm.weidu,
                    longitude: alarm.jingdu,
                    speed: alarm.speed,
                    gps_time: alarm.gps_time,
                    send_time: alarm.send_time
                });
            } else {
                logger.debug(`ℹ️ Alarm type 0x${typeId.toString(16).toUpperCase()} not a device alarm, skipping`);
            }
        } catch (error) {
            logger.error('🔥 Error processing alarm:', error.message);
        }
    }
}

// ========== GPS NOISE FILTER CONFIG ==========
const GPS_NOISE_CONFIG = {
    maxBelievableSpeedKmh:     parseFloat(process.env.GPS_MAX_BELIEVABLE_SPEED_KMH     || '140'),
    maxShortJumpDistanceKm:    parseFloat(process.env.GPS_MAX_SHORT_JUMP_DISTANCE_KM   || '8'),
    shortJumpWindowMinutes:    parseFloat(process.env.GPS_SHORT_JUMP_WINDOW_MINUTES    || '10'),
    speedMismatchToleranceKmh: parseFloat(process.env.GPS_SPEED_MISMATCH_TOLERANCE_KMH || '70'),
    maxHdop:                   parseFloat(process.env.GPS_MAX_HDOP                     || '5'),
    warnHdop:                  parseFloat(process.env.GPS_WARN_HDOP                    || '2.5'),
    // Cameroon operational bounds
    minLat: parseFloat(process.env.GPS_MIN_LAT || '1.5'),
    maxLat: parseFloat(process.env.GPS_MAX_LAT || '13.5'),
    minLng: parseFloat(process.env.GPS_MIN_LNG || '8.0'),
    maxLng: parseFloat(process.env.GPS_MAX_LNG || '16.5'),
};

function parseNumberOrNull(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

function getRecordTimestampMs(rawSysTime, formattedSysTime) {
    const raw = Number(rawSysTime);
    if (Number.isFinite(raw) && raw > 0) {
        return raw < 10000000000 ? raw * 1000 : raw;
    }
    const parsed = Date.parse(formattedSysTime);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function isValidCoordinate(lat, lng) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 &&
        lng >= -180 && lng <= 180 &&
        !(lat === 0 && lng === 0)
    );
}

function isInsideOperationalBounds(lat, lng) {
    return (
        lat >= GPS_NOISE_CONFIG.minLat &&
        lat <= GPS_NOISE_CONFIG.maxLat &&
        lng >= GPS_NOISE_CONFIG.minLng &&
        lng <= GPS_NOISE_CONFIG.maxLng
    );
}

function extractHdop(record) {
    const hdopIndex = process.env.GPS_HDOP_RECORD_INDEX;
    if (hdopIndex === undefined || hdopIndex === null || hdopIndex === '') return null;
    const index = Number(hdopIndex);
    if (!Number.isInteger(index) || index < 0 || index >= record.length) return null;
    return parseNumberOrNull(record[index]);
}

async function getLastKnownPosition(connection, macIdGps) {
    const cached = lastKnownPositions.get(macIdGps);
    if (cached) return cached;

    try {
        const [rows] = await connection.execute(
            `SELECT latitude, longitude, sys_time
             FROM locations
             WHERE mac_id_gps = ?
               AND latitude IS NOT NULL AND longitude IS NOT NULL
               AND latitude <> 0 AND longitude <> 0
             ORDER BY sys_time DESC
                 LIMIT 1`,
            [macIdGps]
        );

        if (!rows || rows.length === 0) return null;

        const lat = parseFloat(rows[0].latitude);
        const lng = parseFloat(rows[0].longitude);
        const timestamp = Date.parse(rows[0].sys_time);

        if (!isValidCoordinate(lat, lng) || !Number.isFinite(timestamp)) return null;

        const lastKnown = { lat, lng, timestamp };
        lastKnownPositions.set(macIdGps, lastKnown);
        return lastKnown;
    } catch (error) {
        logger.warn(`⚠️ Could not load last known GPS point for MAC=${macIdGps}: ${error.message}`);
        return null;
    }
}

function classifyGpsPoint({ macIdGps, corrected, hdop, reportedSpeedKmh, recordTimestampMs, lastKnown }) {
    const reasons = [];
    const metrics = { distanceKm: null, elapsedSeconds: null, impliedSpeedKmh: null };

    if (!isValidCoordinate(corrected.lat, corrected.lng)) {
        return { accepted: false, alertSafe: false, quality: 'INVALID', reasons: ['invalid_coordinate'], metrics };
    }

    if (!isInsideOperationalBounds(corrected.lat, corrected.lng)) {
        return { accepted: false, alertSafe: false, quality: 'INVALID', reasons: ['outside_operational_bounds'], metrics };
    }

    if (hdop !== null && hdop > GPS_NOISE_CONFIG.maxHdop) {
        return { accepted: false, alertSafe: false, quality: 'INVALID', reasons: [`bad_hdop_${hdop}`], metrics };
    }

    let alertSafe = true;
    let quality = 'VALID';

    if (hdop !== null && hdop > GPS_NOISE_CONFIG.warnHdop) {
        reasons.push(`weak_hdop_${hdop}`);
        alertSafe = false;
        quality = 'LOW_CONFIDENCE';
    }

    if (lastKnown && Number.isFinite(lastKnown.timestamp)) {
        const elapsedMs = recordTimestampMs - lastKnown.timestamp;
        const elapsedHours = elapsedMs / 3600000;
        const elapsedSeconds = elapsedMs / 1000;

        if (elapsedMs <= 0) {
            return { accepted: false, alertSafe: false, quality: 'INVALID', reasons: ['old_or_duplicate_timestamp'], metrics };
        }

        const distanceKm = haversineKm(lastKnown.lat, lastKnown.lng, corrected.lat, corrected.lng);
        const impliedSpeedKmh = elapsedHours > 0 ? distanceKm / elapsedHours : 0;

        metrics.distanceKm = distanceKm;
        metrics.elapsedSeconds = elapsedSeconds;
        metrics.impliedSpeedKmh = impliedSpeedKmh;

        // 1. Impossible movement speed
        if (elapsedHours > 0 && elapsedHours < 1 && impliedSpeedKmh > GPS_NOISE_CONFIG.maxBelievableSpeedKmh) {
            return {
                accepted: false, alertSafe: false, quality: 'INVALID',
                reasons: [`impossible_speed_${impliedSpeedKmh.toFixed(0)}kmh`], metrics
            };
        }

        // 2. Large jump while reported speed is almost zero (classic GPS noise)
        if (
            distanceKm >= GPS_NOISE_CONFIG.maxShortJumpDistanceKm &&
            elapsedSeconds <= GPS_NOISE_CONFIG.shortJumpWindowMinutes * 60 &&
            reportedSpeedKmh <= 10
        ) {
            return {
                accepted: false, alertSafe: false, quality: 'INVALID',
                reasons: [`large_jump_with_low_reported_speed_${distanceKm.toFixed(1)}km`], metrics
            };
        }

        // 3. Calculated speed and reported speed disagree too much
        if (
            distanceKm >= GPS_NOISE_CONFIG.maxShortJumpDistanceKm &&
            elapsedSeconds <= GPS_NOISE_CONFIG.shortJumpWindowMinutes * 60 &&
            impliedSpeedKmh > reportedSpeedKmh + GPS_NOISE_CONFIG.speedMismatchToleranceKmh
        ) {
            return {
                accepted: false, alertSafe: false, quality: 'INVALID',
                reasons: [`speed_mismatch_calc_${impliedSpeedKmh.toFixed(0)}kmh_reported_${reportedSpeedKmh.toFixed(0)}kmh`],
                metrics
            };
        }
    }

    return { accepted: true, alertSafe, quality, reasons, metrics };
}

// ========== DATA PROCESSING ==========
async function saveLocationsToDatabase(connection, locations, accountName) {
    logger.debug(`\n📡 ========== GPS DATA PROCESSING [${accountName}] ==========`);

    const invalidatedVehicles = new Set();
    const gpsUpdates          = new Map();
    // Accepted-but-not-yet-persisted records for this cycle. Collected here
    // and written in one batched INSERT after the loop, instead of one
    // sequential INSERT per record -- with up to ~250 vehicles reporting
    // every 10s on a single borrowed pool connection, one-row-at-a-time
    // writes were the single biggest source of per-cycle DB round trips.
    const pendingInserts = [];

    if (locations.success === 'true' && locations.data) {
        let acceptedRecords      = 0;
        let rejectedRecords      = 0;
        let lowConfidenceRecords = 0;

        for (const deviceData of locations.data) {
            if (!deviceData.records || deviceData.records.length === 0) {
                logger.debug(`⚠️ [${accountName}] No records for this device.`);
                continue;
            }

            for (const record of deviceData.records) {
                const formattedSysTime   = convertToDatetime(record[0]);
                const formattedDatetime  = convertToDatetime(record[6]);
                const formattedHeartTime = convertToDatetime(record[7]);
                const macIdGps           = record[11];
                const statenumber        = record[19] || '';
                const rawLat             = parseNumberOrNull(record[3]);
                const rawLng             = parseNumberOrNull(record[2]);
                const reportedSpeedKmh   = parseNumberOrNull(record[8]) || 0;
                const hdop               = extractHdop(record);
                const recordTimestampMs  = getRecordTimestampMs(record[0], formattedSysTime);

                if (!macIdGps || !isValidMacIdFormat(macIdGps)) {
                    rejectedRecords++;
                    logger.warn(`🚫 [${accountName}] Rejected: invalid MAC ID format (need >= ${MIN_MAC_ID_DIGITS} digits): "${macIdGps}"`);
                    continue;
                }

                if (rawLat === null || rawLng === null) {
                    rejectedRecords++;
                    logger.warn(`🚫 [${accountName}] Rejected: MAC=${macIdGps}, invalid raw coordinates Lat=${record[3]}, Lng=${record[2]}`);
                    continue;
                }

                // Store coordinates exactly as the GPS API returns them (true WGS84
                // for Cameroon — map-confirmed). NO datum conversion. record[3]=lat,
                // record[2]=lng. ⛔ Do NOT re-add a GCJ-02/BD-09 conversion here.
                const corrected = { lat: rawLat, lng: rawLng };

                // Resolve voiture_id via the persistent, cross-cycle vehicle cache
                const voitureId = (await getVehicleInfo(connection, macIdGps)).id;

                // GPS quality filter
                const lastKnown  = await getLastKnownPosition(connection, macIdGps);
                const gpsQuality = classifyGpsPoint({
                    macIdGps, corrected, hdop, reportedSpeedKmh, recordTimestampMs, lastKnown
                });

                if (!gpsQuality.accepted) {
                    rejectedRecords++;
                    const distanceText     = gpsQuality.metrics.distanceKm     !== null ? `, Distance=${gpsQuality.metrics.distanceKm.toFixed(2)}km`           : '';
                    const elapsedText      = gpsQuality.metrics.elapsedSeconds  !== null ? `, Elapsed=${gpsQuality.metrics.elapsedSeconds.toFixed(0)}s`          : '';
                    const impliedSpeedText = gpsQuality.metrics.impliedSpeedKmh !== null ? `, ImpliedSpeed=${gpsQuality.metrics.impliedSpeedKmh.toFixed(0)}km/h` : '';
                    logger.warn(
                        `🚫 [${accountName}] Rejected noisy GPS: MAC=${macIdGps}, Reason=${gpsQuality.reasons.join('|')}${distanceText}${elapsedText}${impliedSpeedText}, ReportedSpeed=${reportedSpeedKmh}km/h, HDOP=${hdop ?? 'N/A'}`
                    );
                    continue;
                }

                if (gpsQuality.quality === 'LOW_CONFIDENCE') {
                    lowConfidenceRecords++;
                    logger.warn(`⚠️ [${accountName}] Low-confidence GPS accepted without alert: MAC=${macIdGps}, HDOP=${hdop ?? 'N/A'}`);
                }

                // Update the noise-filter cache immediately (not deferred to
                // after the batch insert) so a second record for the same
                // device later in this same poll cycle still validates
                // against the freshest position, exactly as before.
                lastKnownPositions.set(macIdGps, {
                    lat:       corrected.lat,
                    lng:       corrected.lng,
                    timestamp: recordTimestampMs
                });

                // Queue for the single batched INSERT below -- the rest of the
                // bookkeeping (acceptedRecords, gpsUpdates) happens only after
                // a row has actually been persisted, so an in-memory failure
                // never drifts ahead of the real DB state.
                pendingInserts.push({
                    formattedSysTime, formattedDatetime, formattedHeartTime,
                    userName: record[1], lng: corrected.lng, lat: corrected.lat,
                    reportedSpeedKmh, status: record[9], direction: record[10],
                    macIdGps, voitureId, statenumber, recordTimestampMs, gpsQuality, hdop
                });
            }
        }

        // ===== BATCHED INSERT =====
        // One multi-row INSERT per chunk instead of one row-at-a-time INSERT
        // per record -- collapses what could be ~250 sequential round trips
        // on a single borrowed pool connection down to a handful.
        const INSERT_CHUNK_SIZE = 500;
        for (let i = 0; i < pendingInserts.length; i += INSERT_CHUNK_SIZE) {
            const batch = pendingInserts.slice(i, i + INSERT_CHUNK_SIZE);
            const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const values = batch.flatMap(r => [
                r.formattedSysTime, r.userName, r.lng, r.lat,
                r.formattedDatetime, r.formattedHeartTime, r.reportedSpeedKmh,
                r.status, r.direction, r.macIdGps, r.voitureId
            ]);

            try {
                await connection.query(
                    `INSERT INTO locations
                     (sys_time, user_name, longitude, latitude, datetime, heart_time, speed, status, direction, mac_id_gps, voiture_id)
                     VALUES ${placeholders}`,
                    values
                );

                for (const r of batch) {
                    acceptedRecords++;
                    invalidatedVehicles.add(r.macIdGps);

                    gpsUpdates.set(r.macIdGps, {
                        latitude:       r.lat,
                        longitude:      r.lng,
                        speed:          r.reportedSpeedKmh,
                        status:         r.status,
                        direction:      r.direction,
                        statenumber:    r.statenumber,
                        timestamp:      r.formattedDatetime || new Date().toISOString(),
                        quality:        r.gpsQuality.quality,
                        alertSafe:      r.gpsQuality.alertSafe,
                        qualityReasons: r.gpsQuality.reasons,
                        hdop:           r.hdop
                    });
                }

                logger.debug(`💾 [${accountName}] Batch-saved ${batch.length} location(s)`);
            } catch (error) {
                logger.error(`❌ [${accountName}] Batch insert error (${batch.length} rows):`, error.message);
            }
        }

        logger.info(`📊 [${accountName}] GPS summary: accepted=${acceptedRecords}, rejected=${rejectedRecords}, low_confidence=${lowConfidenceRecords}`);

        // ===== ALERT PROCESSING (DECOUPLED FROM POSITION-SAVE PATH) =====
        // Deliberately NOT awaited: positions for this batch are already
        // durably persisted above. Cache invalidation, Socket.IO emits, and
        // the safe-zone/geofence/speed/timezone checks below no longer need
        // to finish before this account (or the next fetch cycle) can proceed.
        if (invalidatedVehicles.size > 0) {
            processVehicleAlerts(invalidatedVehicles, gpsUpdates, accountName)
                .catch(err => logger.error(`🔥 [${accountName}] Unexpected alert-processing failure:`, err.message));
        }
    } else {
        logger.warn(`❌ [${accountName}] No valid location data:`, locations.errorDescribe || 'Unknown error');
    }

    logger.debug(`========== GPS DATA PROCESSING COMPLETE [${accountName}] ==========\n`);
}

// ========== ALERT PROCESSING (DETACHED FROM POSITION-SAVE PATH) ==========
// Runs after saveLocationsToDatabase() has already returned. Uses
// getVehicleInfoAuto() rather than a passed-in connection, since the
// position-save cycle's borrowed connection may already be released back to
// the pool (and handed to something else) by the time this executes.
async function processVehicleAlerts(invalidatedVehicles, gpsUpdates, accountName) {
    for (const macId of invalidatedVehicles) {
        try {
            const vehicleInfo = await getVehicleInfoAuto(macId);

            if (!vehicleInfo.id) continue;

            const vehicleId = vehicleInfo.id;
            const carModel  = vehicleInfo.model;
            const gpsData   = gpsUpdates.get(macId);

            if (!gpsData) {
                logger.warn(`⚠️ No GPS update in memory for MAC=${macId}, skipping`);
                continue;
            }

            // Cache invalidation
            await cacheInvalidationService.invalidateVehicleLocation(vehicleId);

            // Socket.IO — GPS update
            socketService.emitGPSUpdate(vehicleId, {
                latitude:    gpsData.latitude,
                longitude:   gpsData.longitude,
                speed:       gpsData.speed,
                car_model:   carModel,
                status:      gpsData.status,
                direction:   gpsData.direction,
                timestamp:   gpsData.timestamp,
                mac_id_gps:  macId,
                gps_quality: gpsData.quality,
                alert_safe:  gpsData.alertSafe,
                hdop:        gpsData.hdop
            });

            let gpsStatus = 'Disconnected';
            if (gpsData.status && /1/.test(gpsData.status)) gpsStatus = 'Connected';

            // Socket.IO — Dashboard update
            socketService.emitDashboardUpdate(vehicleId, {
                speed:         gpsData.speed,
                gpsStatus:     gpsStatus,
                vehicleStatus: gpsStatus === 'Connected' ? 'Active' : 'Inactive',
                gpsQuality:    gpsData.quality
            });

            // 🔋 0. Battery monitoring — always runs regardless of alertSafe
            try {
                await BatteryMonitoringService.processBatteryLevel({
                    statenumber: gpsData.statenumber,
                    StateNumber: gpsData.statenumber,
                    weidu:       gpsData.latitude,
                    jingdu:      gpsData.longitude,
                    latitude:    gpsData.latitude,
                    longitude:   gpsData.longitude
                }, macId);
            } catch (batteryError) {
                logger.error(`❌ Battery monitoring error for vehicle ${vehicleId}:`, batteryError.message);
            }

            // Skip movement-based alerts for low-confidence GPS points
            if (!gpsData.alertSafe) {
                logger.warn(`⚠️ Skipping movement alerts for vehicle ${vehicleId}: quality=${gpsData.quality}`);
                continue;
            }

            // ✅ 1. Safe zone violation check
            try {
                const safeZoneResult = await checkSafeZoneViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                if (safeZoneResult.violation && safeZoneResult.isFirstAlert)
                    logger.info(`🚨 SAFE ZONE VIOLATION: Vehicle ${vehicleId} left safe zone`);
                if (safeZoneResult.returned && safeZoneResult.isFirstAlert)
                    logger.info(`✅ SAFE ZONE RETURN: Vehicle ${vehicleId} returned`);
            } catch (safeZoneError) {
                logger.error(`❌ Safe zone check error:`, safeZoneError.message);
            }

            // ✅ 2. Geofence violation check
            try {
                const geofenceResult = await checkGeofenceViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                if (geofenceResult.stateChanged) {
                    if (geofenceResult.currentState === 'outside')
                        logger.info(`🚨 GEOFENCE VIOLATION: Vehicle ${vehicleId} left geofence`);
                    else if (geofenceResult.currentState === 'inside')
                        logger.info(`✅ GEOFENCE RETURN: Vehicle ${vehicleId} returned`);
                }
            } catch (geofenceError) {
                logger.error(`❌ Geofence check error:`, geofenceError.message);
            }

            // ✅ 3. Speed violation check
            try {
                await SpeedAlertService.checkSpeedViolation(
                    vehicleId, macId, gpsData.speed,
                    { latitude: gpsData.latitude, longitude: gpsData.longitude }
                );
            } catch (speedError) {
                logger.error(`❌ Speed check error:`, speedError.message);
            }

            // ✅ 4. Time zone violation check
            try {
                await TimeZoneAlertService.checkTimeZoneViolation(
                    vehicleId, macId, gpsData.speed,
                    { latitude: gpsData.latitude, longitude: gpsData.longitude }
                );
            } catch (timeZoneError) {
                logger.error(`❌ Time zone check error:`, timeZoneError.message);
            }

            // ✅ 5. Device alarms handled via processAlarmData(), on its own cycle

        } catch (error) {
            logger.error(`❌ [${accountName}] Alert processing error for MAC ${macId}:`, error.message);
        }
    }
}

// ========== PER-ACCOUNT POSITION FETCH ==========
// Each account borrows and releases its OWN connection -- running the two
// accounts concurrently means they can no longer share a single connection
// object (mysql2 connections aren't safe for overlapping concurrent queries).
// The pool is sized (connectionLimit: 5) with this in mind.
async function processAccount(account) {
    let connection = null;

    try {
        connection = await getPoolConnection();

        const locations = await withValidToken(account, fetchLocations);
        if (locations) {
            await saveLocationsToDatabase(connection, locations, account.name);
            logger.info(`✅ ${account.name} done`);
            return true;
        }

        logger.warn(`❌ Failed to fetch locations for ${account.name}`);
        return false;
    } catch (accountError) {
        // Error for one account must NOT stop the other account or crash the cycle
        logger.error(`🔥 Error processing ${account.name}:`, accountError.message);
        return false;
    } finally {
        if (connection) {
            try {
                connection.release();
                logger.debug(`✅ [${account.name}] DB connection released back to pool`);
            } catch (releaseError) {
                logger.error('❌ Error releasing DB connection:', releaseError.message);
            }
        }
    }
}

// ========== MAIN GPS FETCH CYCLE (MULTI-ACCOUNT, PARALLEL) ==========
async function fetchGPSData() {
    // Guard: skip this tick if the previous one hasn't finished yet. With the
    // self-rescheduling timer below, a new tick is only ever scheduled after
    // the previous one fully completes, so this is now just a safety net for
    // the case of the cycle being manually stopped and restarted mid-flight.
    if (isFetchingGPS) {
        logger.warn('⏭️ Previous GPS fetch still running, skipping tick');
        return;
    }

    isFetchingGPS = true;

    try {
        logger.info(`\n⏰ [${new Date().toLocaleString()}] Starting GPS fetch cycle...`);

        const results = await Promise.all(GPS_ACCOUNTS.map(account => processAccount(account)));
        const totalOk = results.filter(Boolean).length;

        logger.info(`📊 Cycle complete: ${totalOk} ok, ${results.length - totalOk} failed`);
        logger.debug(`⏰ Next fetch in ${GPS_CONFIG.fetchInterval / 1000}s\n`);

    } catch (error) {
        // Top-level error — log it, do NOT rethrow (that would become an unhandled rejection)
        logger.error('🔥 Fatal error in GPS fetch cycle:', error.message);
        logger.error('Stack:', error.stack);
    } finally {
        isFetchingGPS = false;
    }
}

// ========== PER-ACCOUNT ALARM FETCH (SEPARATE, SLOWER CYCLE) ==========
// Alarms no longer share the position-fetch critical path -- they run on
// their own interval, so a slow alarm fetch for one account can never delay
// position updates for either account.
async function fetchAndProcessAlarms(account) {
    try {
        const alarmData = await withValidToken(account, fetchAlarmData);
        if (alarmData) {
            await processAlarmData(alarmData);
        }
    } catch (alarmError) {
        logger.error(`🔥 Alarm processing error for ${account.name}:`, alarmError.message);
    }
}

let isFetchingAlarms = false;

async function fetchAllAlarms() {
    if (isFetchingAlarms) {
        logger.warn('⏭️ Previous alarm fetch still running, skipping tick');
        return;
    }

    isFetchingAlarms = true;

    try {
        await Promise.all(GPS_ACCOUNTS.map(account => fetchAndProcessAlarms(account)));
    } catch (error) {
        logger.error('🔥 Fatal error in alarm fetch cycle:', error.message);
    } finally {
        isFetchingAlarms = false;
    }
}

// ========== SERVICE CONTROL ==========
// Self-rescheduling setTimeout instead of a fixed setInterval: the next tick
// is only scheduled once the current one has fully finished, so a slow cycle
// can no longer stack up ticks behind it -- it just runs a little later than
// GPS_CONFIG.fetchInterval, instead of silently skipping ticks.
const ALARM_FETCH_INTERVAL_MS = parseInt(process.env.GPS_ALARM_FETCH_INTERVAL) || 45000;

let fetchTimer   = null;
let alarmTimer   = null;
let cycleRunning = false;

function scheduleNextFetch() {
    if (!cycleRunning) return;
    fetchTimer = setTimeout(() => { fetchGPSData().finally(scheduleNextFetch); }, GPS_CONFIG.fetchInterval);
}

function scheduleNextAlarmFetch() {
    if (!cycleRunning) return;
    alarmTimer = setTimeout(() => { fetchAllAlarms().finally(scheduleNextAlarmFetch); }, ALARM_FETCH_INTERVAL_MS);
}

function startGPSFetchCycle() {
    if (cycleRunning) {
        logger.warn('⚠️ GPS fetch cycle is already running');
        return;
    }

    cycleRunning = true;

    logger.info(`🚀 Starting GPS fetch cycle with ${GPS_ACCOUNTS.length} accounts...`);
    GPS_ACCOUNTS.forEach((account, index) => {
        logger.info(`   ${index + 1}. ${account.name} (${account.loginName})`);
    });

    // Run immediately on startup, then self-reschedule after each run completes
    fetchGPSData().finally(scheduleNextFetch);
    fetchAllAlarms().finally(scheduleNextAlarmFetch);

    logger.info(`⏰ GPS fetch cycle started (positions every ${GPS_CONFIG.fetchInterval / 1000}s, alarms every ${ALARM_FETCH_INTERVAL_MS / 1000}s)`);
}

function stopGPSFetchCycle() {
    if (!cycleRunning) {
        logger.warn('⚠️ GPS fetch cycle is not running');
        return;
    }

    cycleRunning = false;
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
    if (alarmTimer) { clearTimeout(alarmTimer); alarmTimer = null; }
    logger.info('🛑 GPS fetch cycle stopped');
}

function isRunning() {
    return cycleRunning;
}

module.exports = {
    startGPSFetchCycle,
    stopGPSFetchCycle,
    fetchGPSData,
    isRunning
};