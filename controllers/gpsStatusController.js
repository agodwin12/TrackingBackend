// controllers/gpsStatusController.js
const Location = require("../models/location");
const Voiture = require("../models/voiture");
const cacheService = require("../services/cacheService");

/**
 * Get the latest location, speed, engine status, and car model of a vehicle.
 * Now with Redis caching and engine status!
 */
exports.getVehicleLocation = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        console.log(`\n📥 ========== NEW REQUEST ==========`);
        console.log(`📥 Received request for Vehicle ID: ${vehicleId}`);

        // ✅ CACHE KEY for this vehicle's location data
        const cacheKey = `vehicle:${vehicleId}:location`;
        console.log(`🔑 Cache Key: ${cacheKey}`);

        // ✅ Step 1: Check Redis cache first
        console.log(`🔍 Checking Redis cache...`);
        const cachedData = await cacheService.get(cacheKey);

        if (cachedData) {
            console.log(`✅ 🎯 CACHE HIT! Returning cached data`);
            console.log(`📊 Cached Data:`, cachedData);
            console.log(`⚡ Response time: ~1-5ms (Redis)`);
            console.log(`========== REQUEST COMPLETED ==========\n`);

            return res.json({
                success: true,
                source: "cache", // ✅ Indicates data came from cache
                ...cachedData
            });
        }

        console.log(`❌ CACHE MISS! Fetching from database...`);

        // ✅ Step 2: Get the vehicle's GPS MAC ID and car model from DB
        console.log(`🔍 Querying Voiture table for vehicle details...`);
        const vehicle = await Voiture.findOne({
            where: { id: vehicleId },
            attributes: ["mac_id_gps", "model"],
        });

        if (!vehicle) {
            console.error("❌ Vehicle not found in database.");
            console.log(`========== REQUEST FAILED ==========\n`);
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const macIdGps = vehicle.mac_id_gps;
        const carModel = vehicle.model;
        console.log(`✅ Vehicle details retrieved from DB:`);
        console.log(`   🔗 GPS MAC ID: ${macIdGps}`);
        console.log(`   🚗 Car Model: ${carModel}`);

        // ✅ Step 3: Get the latest location, speed, and ENGINE STATUS from the locations table
        console.log(`🔍 Querying Location table for GPS data...`);
        const latestLocation = await Location.findOne({
            where: { mac_id_gps: macIdGps },
            order: [["sys_time", "DESC"]],
            attributes: ["latitude", "longitude", "speed", "status"], // ✅ Added status field
        });

        if (!latestLocation) {
            console.error("❌ No GPS data found for this vehicle.");
            console.log(`========== REQUEST FAILED ==========\n`);
            return res.status(404).json({
                success: false,
                message: "No location data available"
            });
        }

        // ✅ Determine engine status (ON/OFF) based on the status field
        // Status is a binary string like "001000100"
        // Index 2 (3rd position) determines engine status: '1' = ON, '0' = OFF
        const statusString = latestLocation.status ? String(latestLocation.status) : '';
        const engineStatus = (statusString.length > 2 && statusString[2] === '1') ? 'ON' : 'OFF';

        console.log(`✅ GPS Data retrieved from DB:`);
        console.log(`   📍 Latitude: ${latestLocation.latitude}`);
        console.log(`   📍 Longitude: ${latestLocation.longitude}`);
        console.log(`   🏎️ Speed: ${latestLocation.speed} Km/h`);
        console.log(`   🔧 Status String: ${statusString}`);
        console.log(`   🔧 Index 2 Value: ${statusString[2]}`);
        console.log(`   🔧 Engine Status: ${engineStatus}`);
        console.log(`⏱️ Response time: ~50-200ms (Database)`);

        // ✅ Step 4: Prepare response data
        const responseData = {
            vehicleId,
            mac_id_gps: macIdGps,
            latitude: latestLocation.latitude,
            longitude: latestLocation.longitude,
            speed: latestLocation.speed,
            car_model: carModel,
            engine_status: engineStatus, // ✅ 'ON' or 'OFF'
            raw_status: latestLocation.status // ✅ For debugging purposes
        };

        // ✅ Step 5: Store in Redis cache (TTL: 5 minutes = 300 seconds)
        console.log(`💾 Storing data in Redis cache...`);
        console.log(`⏰ TTL: 300 seconds (5 minutes)`);
        await cacheService.set(cacheKey, responseData, 300);
        console.log(`✅ Data cached successfully!`);

        console.log(`========== REQUEST COMPLETED ==========\n`);

        res.json({
            success: true,
            source: "database", // ✅ Indicates data came from DB
            ...responseData
        });

    } catch (error) {
        console.error(`\n🔥 ========== ERROR ==========`);
        console.error("🔥 Error fetching location:", error.message);
        console.error("🔥 Stack trace:", error.stack);
        console.log(`========== ERROR END ==========\n`);

        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
};