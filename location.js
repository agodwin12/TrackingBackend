// location.js - GPS TRACKING SERVICE (Integrated with Socket.IO + Safe Zone + Geofence + Speed + Time Zone + Battery)
const axios = require('axios');
const mysql = require('mysql2/promise');
const cacheInvalidationService = require('./services/cacheInvalidationService');
const socketService = require('./services/socketService');
const { checkSafeZoneViolation } = require('./controllers/safeZoneController');
const { checkGeofenceViolation } = require('./controllers/geofenceMonitorController');
const SpeedAlertService = require('./services/speedAlertService');
const TimeZoneAlertService = require('./services/timeZoneAlertService');
const BatteryAlertService = require('./services/batteryAlertService'); // ✅ NEW
require('dotenv').config();

// ========== CONFIGURATION FROM ENV ==========
const GPS_CONFIG = {
    loginName: process.env.GPS_LOGIN_NAME || 'Proxym_tracking',
    loginPassword: process.env.GPS_LOGIN_PASSWORD || 'proxym123',
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
        console.log('✅ Connected to the database');

        // Disable strict mode for this session to allow '0000-00-00 00:00:00'
        await connection.query("SET SESSION sql_mode='ALLOW_INVALID_DATES';");

        return connection;
    } catch (error) {
        console.error('🔥 Database connection failed:', error.message);
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
            console.log('✅ Login successful');
            console.log('🔑 Token:', data.mds);
            console.log('👤 User ID:', data.id);
            return { token: data.mds, userId: data.id };
        } else {
            console.log('❌ Login failed:', data.msg || 'User name or password error');
            return null;
        }
    } catch (error) {
        console.error('🔥 Login API error:', error.message);
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
            console.log('✅ Locations fetched successfully');
            return data;
        } else {
            console.log('❌ Failed to fetch locations:', data.errorDescribe);
            return null;
        }
    } catch (error) {
        console.error('🔥 Fetch locations API error:', error.message);
        return null;
    }
}

// ========== DATA PROCESSING ==========
async function saveLocationsToDatabase(connection, locations) {
    console.log('\n📡 ========== GPS DATA PROCESSING ==========');

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
                    const statenumber = record[19] || ''; // ✅ Battery data is here

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
                            statenumber: statenumber, // ✅ Store for battery check
                            timestamp: formattedDatetime || new Date().toISOString()
                        });

                        console.log(`💾 Location saved: MAC=${macIdGps}, Lat=${record[3]}, Lng=${record[2]}, Speed=${record[8]} km/h`);
                    } catch (error) {
                        console.error('❌ Error saving location:', error.message);
                    }
                }
            } else {
                console.log('⚠️ No records to save for this device.');
            }
        }

        console.log(`\n✅ Total records saved: ${totalRecords}`);

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
                        console.log(`\n🔍 Running alert checks for vehicle ${vehicleId}...`);

                        // ✅ 1. Safe zone violation check
                        try {
                            const safeZoneResult = await checkSafeZoneViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                            if (safeZoneResult.violation) {
                                console.log(`⚠️ SAFE ZONE VIOLATION DETECTED!`);
                                if (safeZoneResult.isFirstAlert) {
                                    console.log(`📧 Safe zone alert created and notification sent`);
                                }
                            }
                        } catch (safeZoneError) {
                            console.error(`❌ Safe zone check error:`, safeZoneError.message);
                        }

                        // ✅ 2. Geofence violation check
                        try {
                            const geofenceResult = await checkGeofenceViolation(vehicleId, gpsData.latitude, gpsData.longitude);
                            if (geofenceResult.violation) {
                                if (geofenceResult.isFirstAlert) {
                                    console.log(`🚨 GEOFENCE VIOLATION DETECTED!`);
                                    console.log(`   Vehicle: ${geofenceResult.vehicleName}`);
                                    console.log(`   Location: ${geofenceResult.locationName || `[${geofenceResult.latitude}, ${geofenceResult.longitude}]`}`);
                                    console.log(`📧 Geofence alert created and notification sent`);
                                } else if (geofenceResult.reason === 'Unread alert exists') {
                                    console.log(`⏳ Geofence violation ongoing (waiting for user to read alert)`);
                                }
                            }
                        } catch (geofenceError) {
                            console.error(`❌ Geofence check error:`, geofenceError.message);
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
                            console.error(`❌ Speed check error:`, speedError.message);
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
                            console.error(`❌ Time zone check error:`, timeZoneError.message);
                        }

                        // ✅ 5. Battery level check (NEW)
                        try {
                            await BatteryAlertService.checkBatteryLevel(
                                { id: vehicleId, nickname: vehicleNickname },
                                gpsData.statenumber
                            );
                        } catch (batteryError) {
                            console.error(`❌ Battery check error:`, batteryError.message);
                        }

                        console.log(`✅ All alert checks completed for vehicle ${vehicleId}`);
                    }
                } catch (error) {
                    console.error(`❌ Processing error for MAC ${macId}:`, error.message);
                }
            }
        }
    } else {
        console.log('❌ No valid location data to save:', locations.errorDescribe || 'Unknown error');
    }

    console.log('\n========== GPS DATA PROCESSING COMPLETE ==========\n');
}

// ========== MAIN GPS FETCH CYCLE ==========
async function fetchGPSData() {
    try {
        console.log(`\n⏰ [${new Date().toLocaleString()}] Starting GPS fetch cycle...`);

        const connection = await connectToDatabase();
        const loginData = await login(GPS_CONFIG.loginName, GPS_CONFIG.loginPassword);

        if (loginData) {
            const { token, userId } = loginData;
            const locations = await fetchLocations(token, userId);

            if (locations) {
                await saveLocationsToDatabase(connection, locations);
            } else {
                console.log('❌ Failed to fetch locations');
            }
        } else {
            console.log('❌ Login failed, cannot fetch locations');
        }

        await connection.end();
        console.log('✅ Database connection closed');
        console.log(`⏰ Next fetch in ${GPS_CONFIG.fetchInterval / 1000} seconds...\n`);

    } catch (error) {
        console.error('🔥 Error in GPS fetch cycle:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

// ========== SERVICE CONTROL ==========
let fetchInterval = null;

function startGPSFetchCycle() {
    if (fetchInterval) {
        console.log('⚠️ GPS fetch cycle is already running');
        return;
    }

    console.log('🚀 Starting GPS fetch cycle...');
    fetchGPSData(); // Run immediately
    fetchInterval = setInterval(fetchGPSData, GPS_CONFIG.fetchInterval);
    console.log(`⏰ GPS fetch cycle started (every ${GPS_CONFIG.fetchInterval / 1000} seconds)`);
}

function stopGPSFetchCycle() {
    if (fetchInterval) {
        clearInterval(fetchInterval);
        fetchInterval = null;
        console.log('🛑 GPS fetch cycle stopped');
    } else {
        console.log('⚠️ GPS fetch cycle is not running');
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