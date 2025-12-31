// services/OptimizedGpsStatusService.js
// ⭐ REPLACE ENTIRE FILE - USES CORRECT API METHOD

const { Op } = require("sequelize");
const cacheService = require("./cacheService");
const { loginGps } = require("./GpsService");
const axios = require("axios");

/**
 * Parse GPS status string (8-character binary string)
 * Position 3 = Relay/Engine state (1=ON, 0=OFF)
 *
 * @param {string} statusString - 8-character binary status string
 * @returns {Object} - Parsed status object
 */
function parseGpsStatus(statusString) {
    // Ensure we have a 9-character string
    const status = String(statusString || "000000000").padEnd(9, "0");

    return {
        accOn: status[0] === "1",           // Position 0: ACC state
        defenseOn: status[1] === "1",       // Position 1: Defense state
        engineOn: status[2] === "1",        // Position 2: RELAY/ENGINE ⭐ CORRECT!
        gpsSignal: status[3] === "1",       // Position 3: GPS signal (1=valid, 0=invalid)
        oilPowerOn: status[4] === "1",      // Position 4: Oil/power state
        doorOpen: status[5] === "1",        // Position 5: Door state
        reserved: status[6] === "1",        // Position 6: Reserved
        reserved2: status[7] === "1",       // Position 7: Reserved
        customAlarm: status[8] === "1",     // Position 8: Custom alarm
        rawStatus: status,
    };
}
/**
 * Get vehicle status with 3-tier optimization:
 * 1. Check Redis cache (fastest)
 * 2. Query database (fast)
 * 3. Call GPS API (fallback)
 *
 * @param {number} vehicleId - Vehicle ID
 * @param {string} macIdGps - Device MAC/IMEI
 * @returns {Promise<Object>} - Vehicle status
 */
async function getVehicleStatus(vehicleId, macIdGps) {
    console.log(`🔍 Getting status for vehicle ${vehicleId} (MAC: ${macIdGps})`);

    try {
        // ========== TIER 1: CHECK CACHE (⚡ ~1ms) ==========
        const cacheKey = `vehicle:${vehicleId}:status`;
        const cachedStatus = await cacheService.get(cacheKey);

        if (cachedStatus) {
            console.log("✅ Cache HIT - Returning cached status");
            return {
                success: true,
                source: "cache",
                ...cachedStatus,
            };
        }

        console.log("⚠️ Cache MISS - Querying database");

        // ========== TIER 2: QUERY DATABASE (🗄️ ~10-50ms) ==========
        const db = require("../models");
        const Location = db.Location;

        const latestLocation = await Location.findOne({
            where: {
                mac_id_gps: macIdGps,
            },
            order: [["sys_time", "DESC"]], // Most recent record
            attributes: [
                "sys_time",
                "latitude",
                "longitude",
                "speed",
                "status",
                "datetime",
                "heart_time",
                "direction",
            ],
            raw: true,
        });

        if (latestLocation) {
            // Check if data is recent (less than 5 minutes old)
            const dataAge = Date.now() - new Date(latestLocation.sys_time).getTime();
            const isRecent = dataAge < 5 * 60 * 1000; // 5 minutes

            if (isRecent) {
                console.log("✅ Database HIT - Recent data found");

                // Parse the status string from database
                const parsedStatus = parseGpsStatus(latestLocation.status);

                const statusData = {
                    engineOn: parsedStatus.engineOn,
                    accOn: parsedStatus.accOn,
                    gpsSignal: parsedStatus.gpsSignal ? "Connected" : "Disconnected",
                    speed: latestLocation.speed || 0,
                    latitude: latestLocation.latitude || 0,
                    longitude: latestLocation.longitude || 0,
                    deviceTime: latestLocation.datetime,
                    lastUpdate: latestLocation.sys_time,
                    rawStatus: parsedStatus.rawStatus,
                    oilPowerOn: parsedStatus.oilPowerOn,
                    direction: latestLocation.direction,
                };

                // Cache for 60 seconds
                await cacheService.set(cacheKey, statusData, 60);

                return {
                    success: true,
                    source: "database",
                    dataAgeSeconds: Math.floor(dataAge / 1000),
                    ...statusData,
                };
            }

            console.log(`⚠️ Database data too old (${Math.floor(dataAge / 1000)}s) - Falling back to API`);
        } else {
            console.log("⚠️ No database record found - Falling back to API");
        }

        // ========== TIER 3: GPS API FALLBACK (🌐 ~500-2000ms) ==========
        console.log("🌐 Calling GPS provider API...");

        const token = await loginGps();
        if (!token) {
            throw new Error("GPS login failed");
        }

        console.log("🔑 GPS login successful, fetching device data...");

        // ⭐ CORRECT API METHOD: getUserAndGpsInfoByIDsUtc
        const response = await axios.get(
            "http://apitest.18gps.net/GetDateServices.asmx/GetDate",
            {
                params: {
                    method: "getUserAndGpsInfoByIDsUtc",  // ⭐ CORRECT METHOD
                    mds: token,
                    simlist: macIdGps,
                },
                timeout: 10000,
            }
        );

        console.log("📡 GPS API Response Status:", response.status);

        // ⭐ Check response structure
        if (!response.data) {
            throw new Error("GPS API returned empty response");
        }

        if (response.data.success !== "true") {
            console.error("❌ GPS API returned error:", response.data.errorDescribe || "Unknown error");
            throw new Error(response.data.errorDescribe || "GPS API request failed");
        }

        const data = response.data.data || [];
        console.log(`📊 Found ${data.length} device(s) in response`);

        if (data.length === 0) {
            throw new Error("No device data returned from GPS API");
        }

        const deviceData = data[0];

        if (!deviceData.records || deviceData.records.length === 0) {
            throw new Error("No records found in device data");
        }

        console.log(`📊 Found ${deviceData.records.length} record(s)`);

        const latestRecord = deviceData.records[0];

        // ⭐ Extract data from the record array
        // Index mapping based on API documentation:
        // 0 = sys_time, 1 = user_name, 2 = longitude, 3 = latitude,
        // 4 = datetime, 5 = heart_time, 6 = speed, 7 = ???, 8 = status, 9 = direction
        const statusString = latestRecord[8] || "00000000";
        console.log("🔧 Status string from API:", statusString);

        const parsedStatus = parseGpsStatus(statusString);
        console.log("✅ Parsed status:", parsedStatus);

        const statusData = {
            engineOn: parsedStatus.engineOn,
            accOn: parsedStatus.accOn,
            gpsSignal: parsedStatus.gpsSignal ? "Connected" : "Disconnected",
            speed: latestRecord[6] || 0,
            latitude: latestRecord[3] || 0,
            longitude: latestRecord[2] || 0,
            deviceTime: latestRecord[4],
            lastUpdate: latestRecord[0],
            rawStatus: parsedStatus.rawStatus,
            oilPowerOn: parsedStatus.oilPowerOn,
            direction: latestRecord[9] || 0,
        };

        // Cache for 60 seconds
        await cacheService.set(cacheKey, statusData, 60);

        console.log("✅ API fallback successful");

        return {
            success: true,
            source: "api",
            ...statusData,
        };

    } catch (error) {
        console.error("🔥 Error getting vehicle status:", error.message);

        // ⭐ If we have database data (even if old), use it as last resort
        try {
            const db = require("../models");
            const Location = db.Location;

            const latestLocation = await Location.findOne({
                where: { mac_id_gps: macIdGps },
                order: [["sys_time", "DESC"]],
                attributes: ["sys_time", "latitude", "longitude", "speed", "status", "datetime", "direction"],
                raw: true,
            });

            if (latestLocation) {
                console.log("⚠️ Using stale database data as fallback");
                const dataAge = Date.now() - new Date(latestLocation.sys_time).getTime();
                const parsedStatus = parseGpsStatus(latestLocation.status);

                const statusData = {
                    engineOn: parsedStatus.engineOn,
                    accOn: parsedStatus.accOn,
                    gpsSignal: parsedStatus.gpsSignal ? "Connected" : "Disconnected",
                    speed: latestLocation.speed || 0,
                    latitude: latestLocation.latitude || 0,
                    longitude: latestLocation.longitude || 0,
                    deviceTime: latestLocation.datetime,
                    lastUpdate: latestLocation.sys_time,
                    rawStatus: parsedStatus.rawStatus,
                    oilPowerOn: parsedStatus.oilPowerOn,
                    direction: latestLocation.direction,
                };

                return {
                    success: true,
                    source: "database_stale",
                    dataAgeSeconds: Math.floor(dataAge / 1000),
                    warning: "Using stale data due to API failure",
                    ...statusData,
                };
            }
        } catch (dbError) {
            console.error("🔥 Database fallback also failed:", dbError.message);
        }

        return {
            success: false,
            engineOn: false,
            accOn: false,
            gpsSignal: "Disconnected",
            speed: 0,
            error: error.message,
        };
    }
}

/**
 * Invalidate status cache (call this when sending commands or receiving new GPS data)
 *
 * @param {number} vehicleId - Vehicle ID
 */
async function invalidateStatusCache(vehicleId) {
    const cacheKey = `vehicle:${vehicleId}:status`;
    await cacheService.del(cacheKey);
    console.log(`🗑️ Invalidated cache for vehicle ${vehicleId}`);
}

/**
 * Batch get status for multiple vehicles (for dashboard list view)
 *
 * @param {Array<Object>} vehicles - Array of {vehicleId, macIdGps}
 * @returns {Promise<Object>} - Map of vehicleId to status
 */
async function batchGetVehicleStatus(vehicles) {
    console.log(`📦 Batch fetching status for ${vehicles.length} vehicles`);

    const statusMap = {};

    // Use Promise.all for parallel processing
    const results = await Promise.allSettled(
        vehicles.map(async (vehicle) => {
            const status = await getVehicleStatus(vehicle.vehicleId, vehicle.macIdGps);
            return { vehicleId: vehicle.vehicleId, status };
        })
    );

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            const { vehicleId, status } = result.value;
            statusMap[vehicleId] = status;
        } else {
            // Handle failed requests
            statusMap[vehicles[index].vehicleId] = {
                success: false,
                error: "Failed to fetch status",
            };
        }
    });

    return statusMap;
}

module.exports = {
    getVehicleStatus,
    invalidateStatusCache,
    parseGpsStatus,
    batchGetVehicleStatus,
};