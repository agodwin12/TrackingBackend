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
const redisClient = require('./config/redis');
const cacheService = require('./services/cacheService');
require('dotenv').config();


function gcj02ToWgs84(lat, lng) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;

    function transformLat(x, y) {
        let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
    }

    function transformLng(x, y) {
        let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
    }

    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);

    return { lat: lat - dLat, lng: lng - dLng };
}


// ========== SPEED SANITY FILTER ==========
// Persists across fetch cycles. Keyed by mac_id_gps.
const lastKnownPositions = new Map();

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
    fetchInterval: parseInt(process.env.GPS_FETCH_INTERVAL) || 10000, // 10 seconds
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

// ========== DATABASE CONNECTION ==========
async function connectToDatabase() {
    try {
        const connection = await mysql.createConnection(DB_CONFIG);
        logger.debug('✅ Connected to the database');

        // Disable strict mode for this session to allow '0000-00-00 00:00:00'
        await connection.query("SET SESSION sql_mode='ALLOW_INVALID_DATES';");

        return connection;
    } catch (error) {
        logger.error('🔥 Database connection failed:', error.message);
        throw error;
    }
}

// ========== UTILITY FUNCTIONS ==========
function convertToDatetime(timestamp) {
    // If invalid or 0, return MySQL zero date
    if (!timestamp || isNaN(timestamp) || Number(timestamp) === 0) {
        return '0000-00-00 00:00:00';
    }

    // Convert milliseconds to seconds for JS Date
    const ts = parseInt(timestamp);
    const date = new Date(ts);

    // Ensure valid date
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
            logger.debug('🔑 Token:', data.mds);
            logger.debug('👤 User ID:', data.id);
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

async function fetchLocations(token, userId) {
    const method = 'getDeviceListByCustomId';
    const url = `${GPS_CONFIG.apiUrl}/GetDate`;

    try {
        const response = await axios.get(url, {
            params: {
                method: method,
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
        } else {
            logger.warn('❌ Failed to fetch locations:', data.errorDescribe);
            return null;
        }
    } catch (error) {
        logger.error('🔥 Fetch locations API error:', error.message);
        return null;
    }
}

// ========== FETCH ALARM DATA ==========
async function fetchAlarmData(token, userId) {
    const method = 'getCustomAlarm';
    const url = `${GPS_CONFIG.apiUrl}/GetDate`;

    try {
        logger.debug('🔔 Fetching alarm data...');

        // Get alarms from the last 2 minutes
        const maxTime = Date.now();
        const minTime = maxTime - (2 * 60 * 1000); // 2 minutes ago

        const response = await axios.get(url, {
            params: {
                method: method,
                type: 'custom',
                id: userId,
                mds: token,
                max_time: maxTime,
                timestamp: Date.now()
            },
            timeout: 10000
        });

        const data = response.data;

        if (data.success === 'true' || data.success === true) {
            logger.debug('✅ Alarm data fetched successfully');
            logger.debug(`📊 Total alarms: ${data.total || 0}`);
            return data;
        } else {
            logger.debug('⚠️ No alarm data available');
            return null;
        }
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

    logger.debug('\n🚨 ========== PROCESSING ALARM DATA ==========');
    logger.debug(`📊 Processing ${alarmData.rows.length} alarms...`);

    for (const alarm of alarmData.rows) {
        try {
            const typeId = parseInt(alarm.type_id);

            logger.debug(`\n🔍 Processing alarm:`, {
                type_id: alarm.type_id,
                type_id_hex: `0x${typeId.toString(16).toUpperCase()}`,
                macid: alarm.macid,
                speed: alarm.speed,
                latitude: alarm.weidu,
                longitude: alarm.jingdu
            });

            // Check if this is a supported device alarm (Disconnection/Removal)
            // Supported types: 0x1F (Disconnection), 0x25 (Offline), 0x26 (Removal), 0x43 (Connection Loss), 0x5B (Unplugged)
            if (DeviceAlertService.isAlarmSupported(typeId)) {
                logger.debug(`✅ Supported device alarm detected: 0x${typeId.toString(16).toUpperCase()}`);

                // Process the alarm using the device alert service
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
                logger.debug(`ℹ️ Alarm type 0x${typeId.toString(16).toUpperCase()} (${typeId}) is not a device alarm, skipping`);
            }

        } catch (error) {
            logger.error('🔥 Error processing alarm:', error.message);
            logger.error('🔥 Stack trace:', error.stack);
        }
    }

    logger.debug('🚨 ========== ALARM DATA PROCESSING COMPLETE ==========\n');
}

const GPS_NOISE_CONFIG = {
    maxBelievableSpeedKmh: parseFloat(process.env.GPS_MAX_BELIEVABLE_SPEED_KMH || '140'),
    maxShortJumpDistanceKm: parseFloat(process.env.GPS_MAX_SHORT_JUMP_DISTANCE_KM || '8'),
    shortJumpWindowMinutes: parseFloat(process.env.GPS_SHORT_JUMP_WINDOW_MINUTES || '10'),
    speedMismatchToleranceKmh: parseFloat(process.env.GPS_SPEED_MISMATCH_TOLERANCE_KMH || '70'),

    // HDOP is optional because your current record structure does not clearly show its index.
    // Set GPS_HDOP_RECORD_INDEX in .env only when you know the exact index from the provider.
    maxHdop: parseFloat(process.env.GPS_MAX_HDOP || '5'),
    warnHdop: parseFloat(process.env.GPS_WARN_HDOP || '2.5'),

    // Cameroon operational bounds.
    // This prevents positions from jumping to another country/continent.
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

    // Provider timestamps are usually milliseconds.
    // If seconds are ever sent, normalize to milliseconds.
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
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180 &&
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

    if (hdopIndex === undefined || hdopIndex === null || hdopIndex === '') {
        return null;
    }

    const index = Number(hdopIndex);

    if (!Number.isInteger(index) || index < 0 || index >= record.length) {
        return null;
    }

    return parseNumberOrNull(record[index]);
}

function normalizeCoordinateByMapType(rawLat, rawLng) {
    const mapType = String(GPS_CONFIG.mapType || 'WGS84')
        .toUpperCase()
        .replace('_', '-');

    // IMPORTANT:
    // Only convert when the provider really sends GCJ-02.
    // If GPS_CONFIG.mapType is WGS84, keep the coordinates as-is.
    if (mapType === 'GCJ02' || mapType === 'GCJ-02') {
        return gcj02ToWgs84(rawLat, rawLng);
    }

    return {
        lat: rawLat,
        lng: rawLng
    };
}

async function getLastKnownPosition(connection, macIdGps) {
    const cached = lastKnownPositions.get(macIdGps);

    if (cached) {
        return cached;
    }

    try {
        const [rows] = await connection.execute(
            `
                SELECT latitude, longitude, sys_time
                FROM locations
                WHERE mac_id_gps = ?
                  AND latitude IS NOT NULL
                  AND longitude IS NOT NULL
                  AND latitude <> 0
                  AND longitude <> 0
                ORDER BY sys_time DESC
                LIMIT 1
            `,
            [macIdGps]
        );

        if (!rows || rows.length === 0) {
            return null;
        }

        const lat = parseFloat(rows[0].latitude);
        const lng = parseFloat(rows[0].longitude);
        const timestamp = Date.parse(rows[0].sys_time);

        if (!isValidCoordinate(lat, lng) || !Number.isFinite(timestamp)) {
            return null;
        }

        const lastKnown = {
            lat,
            lng,
            timestamp
        };

        lastKnownPositions.set(macIdGps, lastKnown);
        return lastKnown;
    } catch (error) {
        logger.warn(`⚠️ Could not load last known GPS point for MAC=${macIdGps}: ${error.message}`);
        return null;
    }
}

function classifyGpsPoint({
                              macIdGps,
                              corrected,
                              hdop,
                              reportedSpeedKmh,
                              recordTimestampMs,
                              lastKnown
                          }) {
    const reasons = [];
    const metrics = {
        distanceKm: null,
        elapsedSeconds: null,
        impliedSpeedKmh: null
    };

    if (!isValidCoordinate(corrected.lat, corrected.lng)) {
        reasons.push('invalid_coordinate');
        return {
            accepted: false,
            alertSafe: false,
            quality: 'INVALID',
            reasons,
            metrics
        };
    }

    if (!isInsideOperationalBounds(corrected.lat, corrected.lng)) {
        reasons.push('outside_operational_bounds');
        return {
            accepted: false,
            alertSafe: false,
            quality: 'INVALID',
            reasons,
            metrics
        };
    }

    if (hdop !== null && hdop > GPS_NOISE_CONFIG.maxHdop) {
        reasons.push(`bad_hdop_${hdop}`);
        return {
            accepted: false,
            alertSafe: false,
            quality: 'INVALID',
            reasons,
            metrics
        };
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
            reasons.push('old_or_duplicate_timestamp');
            return {
                accepted: false,
                alertSafe: false,
                quality: 'INVALID',
                reasons,
                metrics
            };
        }

        const distanceKm = haversineKm(
            lastKnown.lat,
            lastKnown.lng,
            corrected.lat,
            corrected.lng
        );

        const impliedSpeedKmh = elapsedHours > 0 ? distanceKm / elapsedHours : 0;

        metrics.distanceKm = distanceKm;
        metrics.elapsedSeconds = elapsedSeconds;
        metrics.impliedSpeedKmh = impliedSpeedKmh;

        // 1. Impossible movement speed.
        if (
            elapsedHours > 0 &&
            elapsedHours < 1 &&
            impliedSpeedKmh > GPS_NOISE_CONFIG.maxBelievableSpeedKmh
        ) {
            reasons.push(`impossible_speed_${impliedSpeedKmh.toFixed(0)}kmh`);
            return {
                accepted: false,
                alertSafe: false,
                quality: 'INVALID',
                reasons,
                metrics
            };
        }

        // 2. Large jump while reported speed is almost zero.
        // This is a very common GPS-noise pattern.
        if (
            distanceKm >= GPS_NOISE_CONFIG.maxShortJumpDistanceKm &&
            elapsedSeconds <= GPS_NOISE_CONFIG.shortJumpWindowMinutes * 60 &&
            reportedSpeedKmh <= 10
        ) {
            reasons.push(`large_jump_with_low_reported_speed_${distanceKm.toFixed(1)}km`);
            return {
                accepted: false,
                alertSafe: false,
                quality: 'INVALID',
                reasons,
                metrics
            };
        }

        // 3. Calculated speed and reported speed disagree too much.
        if (
            distanceKm >= GPS_NOISE_CONFIG.maxShortJumpDistanceKm &&
            elapsedSeconds <= GPS_NOISE_CONFIG.shortJumpWindowMinutes * 60 &&
            impliedSpeedKmh > reportedSpeedKmh + GPS_NOISE_CONFIG.speedMismatchToleranceKmh
        ) {
            reasons.push(
                `speed_mismatch_calc_${impliedSpeedKmh.toFixed(0)}kmh_reported_${reportedSpeedKmh.toFixed(0)}kmh`
            );
            return {
                accepted: false,
                alertSafe: false,
                quality: 'INVALID',
                reasons,
                metrics
            };
        }
    }

    return {
        accepted: true,
        alertSafe,
        quality,
        reasons,
        metrics
    };
}

// ========== DATA PROCESSING ==========
// ========== DATA PROCESSING ==========
async function saveLocationsToDatabase(connection, locations, accountName) {
    logger.debug(`\n📡 ========== GPS DATA PROCESSING [${accountName}] ==========`);

    const invalidatedVehicles = new Set();
    const gpsUpdates          = new Map();
    const macToVoitureId      = new Map(); // one DB lookup per unique MAC per cycle

    if (locations.success === 'true' && locations.data) {
        let totalRecords       = 0;
        let acceptedRecords    = 0;
        let rejectedRecords    = 0;
        let lowConfidenceRecords = 0;

        for (const deviceData of locations.data) {
            if (deviceData.records && deviceData.records.length > 0) {
                for (const record of deviceData.records) {

                    const formattedSysTime   = convertToDatetime(record[0]);
                    const formattedDatetime  = convertToDatetime(record[6]);
                    const formattedHeartTime = convertToDatetime(record[7]);

                    const macIdGps          = record[11];
                    const statenumber       = record[19] || '';
                    const rawLat            = parseNumberOrNull(record[3]);
                    const rawLng            = parseNumberOrNull(record[2]);
                    const reportedSpeedKmh  = parseNumberOrNull(record[8]) || 0;
                    const hdop              = extractHdop(record);
                    const recordTimestampMs = getRecordTimestampMs(record[0], formattedSysTime);

                    if (!macIdGps) {
                        rejectedRecords++;
                        logger.warn(`🚫 [${accountName}] Rejected GPS point: missing MAC ID`);
                        continue;
                    }

                    if (rawLat === null || rawLng === null) {
                        rejectedRecords++;
                        logger.warn(`🚫 [${accountName}] Rejected GPS point: MAC=${macIdGps}, invalid raw coordinates Lat=${record[3]}, Lng=${record[2]}`);
                        continue;
                    }

                    // ── GCJ-02 → WGS84 ─────────────────────────────────────────
                    // 18gps.net sends GCJ-02 regardless of mapType param.
                    // Conversion is forced unconditionally.
                    const corrected = normalizeCoordinateByMapType(rawLat, rawLng);

                    // ── RESOLVE voiture_id ──────────────────────────────────────
                    // Hit DB only once per unique MAC per cycle
                    let voitureId = null;
                    if (macToVoitureId.has(macIdGps)) {
                        voitureId = macToVoitureId.get(macIdGps);
                    } else {
                        try {
                            const [rows] = await connection.execute(
                                'SELECT id FROM voitures WHERE mac_id_gps = ? LIMIT 1',
                                [macIdGps]
                            );
                            voitureId = rows.length > 0 ? rows[0].id : null;
                        } catch (e) {
                            logger.error(`❌ [${accountName}] Failed to resolve voiture_id for MAC ${macIdGps}:`, e.message);
                        }
                        macToVoitureId.set(macIdGps, voitureId);
                    }

                    // ── GPS QUALITY FILTER ──────────────────────────────────────
                    const lastKnown  = await getLastKnownPosition(connection, macIdGps);
                    const gpsQuality = classifyGpsPoint({
                        macIdGps,
                        corrected,
                        hdop,
                        reportedSpeedKmh,
                        recordTimestampMs,
                        lastKnown
                    });

                    if (!gpsQuality.accepted) {
                        rejectedRecords++;

                        const distanceText     = gpsQuality.metrics.distanceKm !== null
                            ? `, Distance=${gpsQuality.metrics.distanceKm.toFixed(2)}km` : '';
                        const elapsedText      = gpsQuality.metrics.elapsedSeconds !== null
                            ? `, Elapsed=${gpsQuality.metrics.elapsedSeconds.toFixed(0)}s` : '';
                        const impliedSpeedText = gpsQuality.metrics.impliedSpeedKmh !== null
                            ? `, ImpliedSpeed=${gpsQuality.metrics.impliedSpeedKmh.toFixed(0)}km/h` : '';

                        logger.warn(
                            `🚫 [${accountName}] Rejected noisy GPS point: MAC=${macIdGps}, Lat=${corrected.lat}, Lng=${corrected.lng}, Reason=${gpsQuality.reasons.join('|')}${distanceText}${elapsedText}${impliedSpeedText}, ReportedSpeed=${reportedSpeedKmh}km/h, HDOP=${hdop ?? 'N/A'}`
                        );
                        continue;
                    }

                    if (gpsQuality.quality === 'LOW_CONFIDENCE') {
                        lowConfidenceRecords++;
                        logger.warn(
                            `⚠️ [${accountName}] Low-confidence GPS point accepted without alert permission: MAC=${macIdGps}, Reason=${gpsQuality.reasons.join('|')}, HDOP=${hdop ?? 'N/A'}`
                        );
                    }

                    const query = `
                        INSERT INTO locations
                        (sys_time, user_name, longitude, latitude, datetime, heart_time, speed, status, direction, mac_id_gps, voiture_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;

                    const values = [
                        formattedSysTime,   // sys_time
                        record[1],          // user_name
                        corrected.lng,      // longitude — WGS84
                        corrected.lat,      // latitude  — WGS84
                        formattedDatetime,  // datetime
                        formattedHeartTime, // heart_time
                        reportedSpeedKmh,   // speed
                        record[9],          // status
                        record[10],         // direction
                        macIdGps,           // mac_id_gps
                        voitureId           // voiture_id
                    ];

                    try {
                        await connection.execute(query, values);

                        totalRecords++;
                        acceptedRecords++;
                        invalidatedVehicles.add(macIdGps);

                        // Update last known accepted position for this device
                        lastKnownPositions.set(macIdGps, {
                            lat:       corrected.lat,
                            lng:       corrected.lng,
                            timestamp: recordTimestampMs
                        });

                        gpsUpdates.set(macIdGps, {
                            latitude:      corrected.lat,
                            longitude:     corrected.lng,
                            speed:         reportedSpeedKmh,
                            status:        record[9],
                            direction:     record[10],
                            statenumber:   statenumber,
                            timestamp:     formattedDatetime || new Date().toISOString(),
                            quality:       gpsQuality.quality,
                            alertSafe:     gpsQuality.alertSafe,
                            qualityReasons: gpsQuality.reasons,
                            hdop:          hdop
                        });

                        const distanceText     = gpsQuality.metrics.distanceKm !== null
                            ? `, Distance=${gpsQuality.metrics.distanceKm.toFixed(2)}km` : '';
                        const impliedSpeedText = gpsQuality.metrics.impliedSpeedKmh !== null
                            ? `, ImpliedSpeed=${gpsQuality.metrics.impliedSpeedKmh.toFixed(0)}km/h` : '';

                        logger.debug(
                            `💾 [${accountName}] Location saved: MAC=${macIdGps}, VoitureID=${voitureId}, Lat=${corrected.lat}, Lng=${corrected.lng}, Speed=${reportedSpeedKmh} km/h, Quality=${gpsQuality.quality}${distanceText}${impliedSpeedText}, HDOP=${hdop ?? 'N/A'}`
                        );
                    } catch (error) {
                        logger.error(`❌ [${accountName}] Error saving location:`, error.message);
                    }
                }
            } else {
                logger.debug(`⚠️ [${accountName}] No records to save for this device.`);
            }
        }

        logger.debug(`\n✅ [${accountName}] Total records saved: ${totalRecords}`);
        logger.info(`📊 [${accountName}] GPS quality summary: accepted=${acceptedRecords}, rejected=${rejectedRecords}, low_confidence=${lowConfidenceRecords}`);

        // ✅ PROCESS CACHE INVALIDATION + SOCKET.IO EMISSION + ALERT CHECKS
        if (invalidatedVehicles.size > 0) {
            for (const macId of invalidatedVehicles) {
                try {
                    const [vehicles] = await connection.execute(
                        'SELECT id, model, nickname FROM voitures WHERE mac_id_gps = ?',
                        [macId]
                    );

                    if (vehicles.length > 0) {
                        const vehicleId      = vehicles[0].id;
                        const carModel       = vehicles[0].model;
                        const gpsData        = gpsUpdates.get(macId);

                        if (!gpsData) {
                            logger.warn(`⚠️ No GPS update found in memory for MAC=${macId}, skipping vehicle update`);
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

                        // Determine GPS status
                        let gpsStatus = 'Disconnected';
                        if (gpsData.status && /1/.test(gpsData.status)) gpsStatus = 'Connected';

                        // Socket.IO — Dashboard update
                        socketService.emitDashboardUpdate(vehicleId, {
                            speed:         gpsData.speed,
                            gpsStatus:     gpsStatus,
                            vehicleStatus: gpsStatus === 'Connected' ? 'Active' : 'Inactive',
                            gpsQuality:    gpsData.quality
                        });

                        // ========== ALERT CHECKS ==========
                        logger.debug(`\n🔍 Running alert checks for vehicle ${vehicleId}...`);
                        logger.debug(`🛰️ GPS quality: ${gpsData.quality}, alertSafe=${gpsData.alertSafe}, reasons=${gpsData.qualityReasons.join('|') || 'none'}`);

                        // 🔋 0. Battery monitoring — runs regardless of alertSafe
                        try {
                            logger.debug(`🔋 Checking battery level for vehicle ${vehicleId}...`);
                            await BatteryMonitoringService.processBatteryLevel({
                                statenumber: gpsData.statenumber,
                                StateNumber: gpsData.statenumber,
                                weidu:       gpsData.latitude,
                                jingdu:      gpsData.longitude,
                                latitude:    gpsData.latitude,
                                longitude:   gpsData.longitude
                            }, macId);
                            logger.debug(`✅ Battery monitoring check completed for vehicle ${vehicleId}`);
                        } catch (batteryError) {
                            logger.error(`❌ Battery monitoring error for vehicle ${vehicleId}:`, batteryError.message);
                        }

                        // Skip movement-based alerts if GPS point is low confidence
                        if (!gpsData.alertSafe) {
                            logger.warn(
                                `⚠️ Skipping movement-based alerts for vehicle ${vehicleId}: GPS point is ${gpsData.quality}, reasons=${gpsData.qualityReasons.join('|') || 'none'}`
                            );
                            logger.debug(`✅ Alert checks skipped safely for vehicle ${vehicleId}`);
                            continue;
                        }

                        // ✅ 1. Safe zone violation check
                        try {
                            const safeZoneResult = await checkSafeZoneViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                            if (safeZoneResult.violation && safeZoneResult.isFirstAlert)
                                logger.info(`🚨 SAFE ZONE VIOLATION DETECTED! Vehicle left the safe zone`);
                            if (safeZoneResult.returned && safeZoneResult.isFirstAlert)
                                logger.info(`✅ VEHICLE RETURNED TO SAFE ZONE!`);
                        } catch (safeZoneError) {
                            logger.error(`❌ Safe zone check error:`, safeZoneError.message);
                        }

                        // ✅ 2. Geofence violation check
                        try {
                            const geofenceResult = await checkGeofenceViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                            if (geofenceResult.stateChanged) {
                                if (geofenceResult.currentState === 'outside') {
                                    logger.info(`🚨 GEOFENCE VIOLATION DETECTED! Vehicle left the defined zone`);
                                    logger.info(`   Previous: ${geofenceResult.previousState} → Current: ${geofenceResult.currentState}`);
                                } else if (geofenceResult.currentState === 'inside') {
                                    logger.info(`✅ VEHICLE RETURNED TO GEOFENCE!`);
                                    logger.info(`   Previous: ${geofenceResult.previousState} → Current: ${geofenceResult.currentState}`);
                                }
                            } else {
                                logger.debug(`ℹ️ No geofence state change (vehicle still ${geofenceResult.currentState || 'in previous state'})`);
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

                        // ✅ 5. Device disconnection/removal alarms handled separately via processAlarmData()

                        logger.debug(`✅ All alert checks completed for vehicle ${vehicleId}`);
                    }
                } catch (error) {
                    logger.error(`❌ Processing error for MAC ${macId}:`, error.message);
                }
            }
        }
    } else {
        logger.warn(`❌ [${accountName}] No valid location data to save:`, locations.errorDescribe || 'Unknown error');
    }

    logger.debug(`\n========== GPS DATA PROCESSING COMPLETE [${accountName}] ==========\n`);
}


// ========== MAIN GPS FETCH CYCLE (MULTI-ACCOUNT) ==========
async function fetchGPSData() {
    if (isFetchingGPS) {
        logger.warn('⏭️ Previous GPS fetch cycle is still running, skipping this tick');
        return;
    }

    isFetchingGPS = true;
    let connection = null;

    try {
        logger.info(`\n⏰ [${new Date().toLocaleString()}] Starting GPS fetch cycle for ${GPS_ACCOUNTS.length} accounts...`);

        connection = await connectToDatabase();

        let totalAccountsProcessed = 0;
        let totalAccountsFailed = 0;

        for (let i = 0; i < GPS_ACCOUNTS.length; i++) {
            const account = GPS_ACCOUNTS[i];

            try {
                logger.info(`\n🔐 ========== Processing ${account.name} (${i + 1}/${GPS_ACCOUNTS.length}) ==========`);
                logger.debug(`📧 Login: ${account.loginName}`);

                const loginData = await login(account.loginName, account.loginPassword);

                if (loginData) {
                    const { token, userId } = loginData;

                    const locations = await fetchLocations(token, userId);
                    if (locations) {
                        logger.info(`📍 Processing locations for ${account.name}...`);
                        await saveLocationsToDatabase(connection, locations, account.name);
                    } else {
                        logger.warn(`❌ Failed to fetch locations for ${account.name}`);
                    }

                    try {
                        const alarmData = await fetchAlarmData(token, userId);
                        if (alarmData) {
                            logger.info(`🚨 Processing alarms for ${account.name}...`);
                            await processAlarmData(alarmData);
                        }
                    } catch (alarmError) {
                        logger.error(`🔥 Error fetching/processing alarms for ${account.name}:`, alarmError.message);
                    }

                    logger.info(`✅ ${account.name} processing complete`);
                    totalAccountsProcessed++;
                } else {
                    logger.warn(`❌ Login failed for ${account.name}`);
                    totalAccountsFailed++;
                }

                if (i < GPS_ACCOUNTS.length - 1) {
                    logger.debug('⏸️ Waiting 500ms before next account...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } catch (accountError) {
                logger.error(`🔥 Error processing ${account.name}:`, accountError.message);
                logger.error('Stack trace:', accountError.stack);
                totalAccountsFailed++;
            }
        }

        logger.info(`\n✅ ========== ALL ACCOUNTS PROCESSED ==========`);
        logger.info(`📊 Summary: ${totalAccountsProcessed} successful, ${totalAccountsFailed} failed`);
        logger.debug(`⏰ Next fetch in ${GPS_CONFIG.fetchInterval / 1000} seconds...\n`);

    } catch (error) {
        logger.error('🔥 Error in GPS fetch cycle:', error.message);
        logger.error('Stack trace:', error.stack);
    } finally {
        if (connection) {
            try {
                await connection.end();
                logger.debug('✅ Database connection closed');
            } catch (closeError) {
                logger.error('❌ Error closing database connection:', closeError.message);
            }
        }

        isFetchingGPS = false;
    }
}

// ========== SERVICE CONTROL ==========
let fetchInterval = null;

function startGPSFetchCycle() {
    if (fetchInterval) {
        logger.warn('⚠️ GPS fetch cycle is already running');
        return;
    }

    logger.info(`🚀 Starting GPS fetch cycle with ${GPS_ACCOUNTS.length} accounts...`);
    logger.info(`📋 Accounts configured:`);
    GPS_ACCOUNTS.forEach((account, index) => {
        logger.info(`   ${index + 1}. ${account.name} (${account.loginName})`);
    });

    fetchGPSData(); // Run immediately
    fetchInterval = setInterval(fetchGPSData, GPS_CONFIG.fetchInterval);
    logger.info(`⏰ GPS fetch cycle started (every ${GPS_CONFIG.fetchInterval / 1000} seconds)`);
}

function stopGPSFetchCycle() {
    if (fetchInterval) {
        clearInterval(fetchInterval);
        fetchInterval = null;
        logger.info('🛑 GPS fetch cycle stopped');
    } else {
        logger.warn('⚠️ GPS fetch cycle is not running');
    }
}

function isRunning() {
    return fetchInterval !== null;
}

// ========== EXPORTS ==========
module.exports = {
    startGPSFetchCycle,
    stopGPSFetchCycle,
    fetchGPSData,
    isRunning
};