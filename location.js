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

// ========== DATA PROCESSING ==========
async function saveLocationsToDatabase(connection, locations, accountName) {
    logger.debug(`\n📡 ========== GPS DATA PROCESSING [${accountName}] ==========`);

    const invalidatedVehicles = new Set();
    const gpsUpdates = new Map();

    if (locations.success === 'true' && locations.data) {
        let totalRecords = 0;

        for (const deviceData of locations.data) {
            if (deviceData.records && deviceData.records.length > 0) {
                for (const record of deviceData.records) {
                    const query = `
                        INSERT INTO locations
                        (sys_time, user_name, longitude, latitude, datetime, heart_time, speed, status, direction, mac_id_gps)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;

                    const formattedSysTime = convertToDatetime(record[0]);
                    const formattedDatetime = convertToDatetime(record[6]);
                    const formattedHeartTime = convertToDatetime(record[7]);
                    const macIdGps = record[11];
                    const statenumber = record[19] || '';

                    const values = [
                        formattedSysTime,   // sys_time
                        record[1],          // user_name
                        record[2],          // longitude
                        record[3],          // latitude
                        formattedDatetime,  // datetime
                        formattedHeartTime, // heart_time
                        record[8],          // speed
                        record[9],          // status
                        record[10],         // direction
                        macIdGps            // mac_id_gps
                    ];

                    try {
                        await connection.execute(query, values);
                        totalRecords++;

                        invalidatedVehicles.add(macIdGps);

                        gpsUpdates.set(macIdGps, {
                            latitude: parseFloat(record[3]),
                            longitude: parseFloat(record[2]),
                            speed: parseFloat(record[8]),
                            status: record[9],
                            direction: record[10],
                            statenumber: statenumber, // 🆕 Store statenumber for battery monitoring
                            timestamp: formattedDatetime || new Date().toISOString()
                        });

                        logger.debug(`💾 [${accountName}] Location saved: MAC=${macIdGps}, Lat=${record[3]}, Lng=${record[2]}, Speed=${record[8]} km/h`);
                    } catch (error) {
                        logger.error(`❌ [${accountName}] Error saving location:`, error.message);
                    }
                }
            } else {
                logger.debug(`⚠️ [${accountName}] No records to save for this device.`);
            }
        }

        logger.debug(`\n✅ [${accountName}] Total records saved: ${totalRecords}`);

        // ✅ PROCESS CACHE INVALIDATION + SOCKET.IO EMISSION + ALL ALERT CHECKS
        if (invalidatedVehicles.size > 0) {
            for (const macId of invalidatedVehicles) {
                try {
                    const [vehicles] = await connection.execute(
                        'SELECT id, model, nickname FROM voitures WHERE mac_id_gps = ?',
                        [macId]
                    );

                    if (vehicles.length > 0) {
                        const vehicleId = vehicles[0].id;
                        const carModel = vehicles[0].model;
                        const vehicleNickname = vehicles[0].nickname || vehicles[0].model;
                        const gpsData = gpsUpdates.get(macId);

                        // Cache invalidation
                        await cacheInvalidationService.invalidateVehicleLocation(vehicleId);

                        // Socket.IO - GPS update
                        socketService.emitGPSUpdate(vehicleId, {
                            latitude: gpsData.latitude,
                            longitude: gpsData.longitude,
                            speed: gpsData.speed,
                            car_model: carModel,
                            status: gpsData.status,
                            direction: gpsData.direction,
                            timestamp: gpsData.timestamp,
                            mac_id_gps: macId
                        });

                        // Determine GPS status
                        let gpsStatus = "Disconnected";
                        if (gpsData.status && /1/.test(gpsData.status)) gpsStatus = "Connected";

                        // Socket.IO - Dashboard update
                        socketService.emitDashboardUpdate(vehicleId, {
                            speed: gpsData.speed,
                            gpsStatus: gpsStatus,
                            vehicleStatus: gpsStatus === "Connected" ? "Active" : "Inactive"
                        });

                        // ========== ALERT CHECKS ==========
                        logger.debug(`\n🔍 Running alert checks for vehicle ${vehicleId}...`);

                        // 🔋 0. BATTERY MONITORING CHECK (FIRST - runs on every GPS update)
                        try {
                            logger.debug(`🔋 Checking battery level for vehicle ${vehicleId}...`);

                            await BatteryMonitoringService.processBatteryLevel({
                                statenumber: gpsData.statenumber,
                                StateNumber: gpsData.statenumber,
                                weidu: gpsData.latitude,
                                jingdu: gpsData.longitude,
                                latitude: gpsData.latitude,
                                longitude: gpsData.longitude
                            }, macId);

                            logger.debug(`✅ Battery monitoring check completed for vehicle ${vehicleId}`);
                        } catch (batteryError) {
                            logger.error(`❌ Battery monitoring error for vehicle ${vehicleId}:`, batteryError.message);
                        }

                        // ✅ 1. Safe zone violation check (FIXED - handles both leave AND return)
                        try {
                            const safeZoneResult = await checkSafeZoneViolation(vehicleId, gpsData.latitude, gpsData.longitude);

                            // Handle vehicle LEAVING safe zone
                            if (safeZoneResult.violation && safeZoneResult.isFirstAlert) {
                                logger.info(`🚨 SAFE ZONE VIOLATION DETECTED!`);
                                logger.info(`   Vehicle left the safe zone`);
                                logger.info(`📧 Safe zone "left" alert created and notification sent`);
                            }

                            // ✅ FIXED: Handle vehicle RETURNING to safe zone
                            if (safeZoneResult.returned && safeZoneResult.isFirstAlert) {
                                logger.info(`✅ VEHICLE RETURNED TO SAFE ZONE!`);
                                logger.info(`   Vehicle returned to safe zone`);
                                logger.info(`📧 Safe zone "returned" alert created and notification sent`);
                            }
                        } catch (safeZoneError) {
                            logger.error(`❌ Safe zone check error:`, safeZoneError.message);
                        }

                        // ✅ 2. Geofence violation check (UPDATED - no more cooldown logic)
                        try {
                            const geofenceResult = await checkGeofenceViolation(vehicleId, gpsData.latitude, gpsData.longitude);

                            // Handle state changes (leaving or returning)
                            if (geofenceResult.stateChanged) {
                                if (geofenceResult.currentState === 'outside') {
                                    // Vehicle LEFT the geofence
                                    logger.info(`🚨 GEOFENCE VIOLATION DETECTED!`);
                                    logger.info(`   Vehicle left the defined zone`);
                                    logger.info(`   Previous state: ${geofenceResult.previousState}`);
                                    logger.info(`   Current state: ${geofenceResult.currentState}`);
                                    logger.info(`📧 Geofence alert created and notification sent`);
                                } else if (geofenceResult.currentState === 'inside') {
                                    logger.info(`✅ VEHICLE RETURNED TO GEOFENCE!`);
                                    logger.info(`   Vehicle returned to the defined zone`);
                                    logger.info(`   Previous state: ${geofenceResult.previousState}`);
                                    logger.info(`   Current state: ${geofenceResult.currentState}`);
                                    logger.info(`📧 Geofence return alert created and notification sent`);
                                }
                            } else {
                                // No state change - vehicle still in same state
                                logger.debug(`ℹ️ No geofence state change (vehicle still ${geofenceResult.currentState || 'in previous state'})`);
                            }
                        } catch (geofenceError) {
                            logger.error(`❌ Geofence check error:`, geofenceError.message);
                        }

                        // ✅ 3. Speed violation check
                        try {
                            await SpeedAlertService.checkSpeedViolation(
                                vehicleId,
                                macId,
                                gpsData.speed,
                                {
                                    latitude: gpsData.latitude,
                                    longitude: gpsData.longitude
                                }
                            );
                        } catch (speedError) {
                            logger.error(`❌ Speed check error:`, speedError.message);
                        }

                        // ✅ 4. Time zone violation check
                        try {
                            await TimeZoneAlertService.checkTimeZoneViolation(
                                vehicleId,
                                macId,
                                gpsData.speed,
                                {
                                    latitude: gpsData.latitude,
                                    longitude: gpsData.longitude
                                }
                            );
                        } catch (timeZoneError) {
                            logger.error(`❌ Time zone check error:`, timeZoneError.message);
                        }

                        // ✅ 5. Device disconnection/removal alarms
                        // These are handled separately via alarm data processing
                        // See processAlarmData() function which processes device alarms from GPS provider

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
    try {
        logger.info(`\n⏰ [${new Date().toLocaleString()}] Starting GPS fetch cycle for ${GPS_ACCOUNTS.length} accounts...`);

        const connection = await connectToDatabase();

        let totalAccountsProcessed = 0;
        let totalAccountsFailed = 0;

        // ✅ Process each account sequentially
        for (let i = 0; i < GPS_ACCOUNTS.length; i++) {
            const account = GPS_ACCOUNTS[i];

            try {
                logger.info(`\n🔐 ========== Processing ${account.name} (${i + 1}/${GPS_ACCOUNTS.length}) ==========`);
                logger.debug(`📧 Login: ${account.loginName}`);

                const loginData = await login(account.loginName, account.loginPassword);

                if (loginData) {
                    const { token, userId } = loginData;

                    // ✅ 1. Fetch and save location data for this account
                    const locations = await fetchLocations(token, userId);
                    if (locations) {
                        logger.info(`📍 Processing locations for ${account.name}...`);
                        await saveLocationsToDatabase(connection, locations, account.name);
                    } else {
                        logger.warn(`❌ Failed to fetch locations for ${account.name}`);
                    }

                    // ✅ 2. Fetch and process alarm data for this account
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

                // Small delay between accounts to avoid rate limiting
                if (i < GPS_ACCOUNTS.length - 1) {
                    logger.debug('⏸️ Waiting 500ms before next account...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } catch (accountError) {
                logger.error(`🔥 Error processing ${account.name}:`, accountError.message);
                logger.error('Stack trace:', accountError.stack);
                totalAccountsFailed++;
                // Continue to next account even if one fails
            }
        }

        await connection.end();
        logger.debug('✅ Database connection closed');

        logger.info(`\n✅ ========== ALL ACCOUNTS PROCESSED ==========`);
        logger.info(`📊 Summary: ${totalAccountsProcessed} successful, ${totalAccountsFailed} failed`);
        logger.debug(`⏰ Next fetch in ${GPS_CONFIG.fetchInterval / 1000} seconds...\n`);

    } catch (error) {
        logger.error('🔥 Error in GPS fetch cycle:', error.message);
        logger.error('Stack trace:', error.stack);
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