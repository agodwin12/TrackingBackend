// controllers/alertController.js
const { Alert, Voiture, User } = require("../models");
const { Op } = require('sequelize');
const axios = require('axios');

// ========== SMART STATE CHANGE DETECTION (UPDATED) ==========
const filterStateChangeAlerts = (alerts) => {
    if (alerts.length === 0) return [];

    console.log(`\n🧠 SMART STATE CHANGE FILTERING`);
    console.log(`📊 Total alerts to process: ${alerts.length}`);
    console.log(`========================================`);

    const filteredAlerts = [];

    for (let i = 0; i < alerts.length; i++) {
        const alert = alerts[i];
        const subtype = alert.alert_subtype;

        // ✅ NEW: Filter out STILL_OUTSIDE alerts (internal logs only)
        if (subtype === 'STILL_OUTSIDE') {
            console.log(`⏭️  Alert ${alert.id}: STILL_OUTSIDE (internal log), skipping`);
            continue;
        }

        // ✅ NEW: Only show LEFT_ZONE and RETURNED_ZONE
        if (subtype === 'LEFT_ZONE' || subtype === 'RETURNED_ZONE') {
            filteredAlerts.push(alert);
            console.log(`✅ Alert ${alert.id}: ${subtype} - INCLUDED`);
            console.log(`   Message: "${alert.message}"`);
            console.log(`   Time: ${new Date(alert.alerted_at).toLocaleString()}`);
        } else {
            // ✅ LEGACY: Handle old alerts without subtype (parse message)
            const message = alert.message.toLowerCase();
            let currentState = null;

            if (message.includes('left') && (message.includes('geofence') || message.includes('safe zone') || message.includes('defined zone'))) {
                currentState = 'left';
            } else if (message.includes('returned') && (message.includes('geofence') || message.includes('safe zone') || message.includes('defined zone'))) {
                currentState = 'returned';
            }

            if (currentState) {
                filteredAlerts.push(alert);
                console.log(`✅ Alert ${alert.id}: LEGACY ${currentState} - INCLUDED`);
                console.log(`   Message: "${alert.message}"`);
            } else {
                console.log(`⚠️  Alert ${alert.id}: Unknown type, skipping`);
            }
        }
    }

    console.log(`========================================`);
    console.log(`🎯 FILTERING COMPLETE`);
    console.log(`   Original alerts: ${alerts.length}`);
    console.log(`   Filtered alerts: ${filteredAlerts.length}`);
    console.log(`   Removed: ${alerts.length - filteredAlerts.length} internal/spam alerts`);
    console.log(`========================================\n`);

    return filteredAlerts;
};

// ========== GET ALERTS BY VEHICLE WITH SMART FILTERING ==========
exports.getAlertsByVehicle = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        console.log(`📥 Fetching alerts for vehicle ${vehicleId} - Page: ${page}, Limit: ${limit}`);

        // ✅ Filter: Only safe_zone and geofence alerts
        const whereClause = {
            voiture_id: vehicleId,
            alert_type: {
                [Op.in]: ['safe_zone', 'geofence']
            }
        };

        // ✅ STEP 1: Get ALL alerts (ordered by time DESC - newest first)
        console.log(`🔍 Fetching all alerts from database...`);
        const allAlerts = await Alert.findAll({
            where: whereClause,
            order: [["alerted_at", "DESC"]]
        });

        console.log(`✅ Found ${allAlerts.length} total alerts in database`);

        // ✅ STEP 2: Apply smart STATE CHANGE filtering
        const stateChangeAlerts = filterStateChangeAlerts(allAlerts);

        // ✅ STEP 3: Apply pagination to filtered results
        const totalFilteredAlerts = stateChangeAlerts.length;
        const paginatedAlerts = stateChangeAlerts.slice(offset, offset + limit);

        const totalPages = Math.ceil(totalFilteredAlerts / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        console.log(`✅ Returning ${paginatedAlerts.length} alerts (page ${page} of ${totalPages})`);

        res.json({
            success: true,
            data: {
                alerts: paginatedAlerts,
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalAlerts: totalFilteredAlerts,
                    totalAlertsInDb: allAlerts.length,
                    limit: limit,
                    hasNextPage: hasNextPage,
                    hasPrevPage: hasPrevPage,
                    spamAlertsFiltered: allAlerts.length - totalFilteredAlerts
                }
            }
        });
    } catch (error) {
        console.error("🔥 Error fetching alerts:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching alerts",
            error: error.message,
        });
    }
};

// ========== MARK ALERT AS READ ==========
exports.markAlertAsRead = async (req, res) => {
    try {
        const { id } = req.params;

        const alert = await Alert.findByPk(id);

        if (!alert) {
            return res.status(404).json({
                success: false,
                message: "Alert not found",
            });
        }

        alert.read = true;
        await alert.save();

        console.log(`✅ Alert ${id} marked as read`);

        res.json({
            success: true,
            message: "Alert marked as read",
            alert,
        });
    } catch (error) {
        console.error("🔥 Error marking alert as read:", error);
        res.status(500).json({
            success: false,
            message: "Error marking alert as read",
            error: error.message,
        });
    }
};

// ========== MARK ALL ALERTS AS READ ==========
exports.markAllAsRead = async (req, res) => {
    try {
        const { vehicleId } = req.params;

        // ✅ Only mark safe_zone and geofence alerts as read
        const [updatedCount] = await Alert.update(
            { read: true },
            {
                where: {
                    voiture_id: vehicleId,
                    read: false,
                    alert_type: {
                        [Op.in]: ['safe_zone', 'geofence']
                    }
                }
            }
        );

        console.log(`✅ Marked ${updatedCount} alerts as read for vehicle ${vehicleId}`);

        res.json({
            success: true,
            message: `${updatedCount} alerts marked as read`,
        });
    } catch (error) {
        console.error("🔥 Error marking all alerts as read:", error);
        res.status(500).json({
            success: false,
            message: "Error marking all alerts as read",
            error: error.message,
        });
    }
};

// ========== REPORT STOLEN VEHICLE ==========
exports.reportStolenVehicle = async (req, res) => {
    try {
        console.log("🚨 [REPORT STOLEN] Request received");
        console.log("📝 Request Body:", JSON.stringify(req.body, null, 2));

        const { vehicleId, userId, latitude, longitude } = req.body;

        if (vehicleId === undefined || vehicleId === null || userId === undefined || userId === null) {
            console.error("❌ Validation failed: Missing required fields");
            return res.status(400).json({
                success: false,
                message: "Vehicle ID and User ID are required"
            });
        }

        if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
            console.error("❌ Validation failed: Missing location");
            return res.status(400).json({
                success: false,
                message: "Vehicle location is required to find nearby police"
            });
        }

        console.log(`🚨 Reporting vehicle ${vehicleId} as STOLEN by user ${userId}`);
        console.log(`📍 Location: ${latitude}, ${longitude}`);

        // Check for existing active stolen alert
        const existingAlert = await Alert.findOne({
            where: {
                voiture_id: vehicleId,
                alert_type: 'stolen',
                alert_status: 'ACTIVE'
            }
        });

        // If alert exists, return it with fresh police data
        if (existingAlert) {
            console.log("⚠️ Active stolen alert already exists - returning with fresh police data");

            const alertLat = parseFloat(latitude);
            const alertLng = parseFloat(longitude);

            const nearbyPolice = await findNearbyPolice(alertLat, alertLng);

            console.log(`🚔 Found ${nearbyPolice.length} nearby police stations`);

            return res.status(200).json({
                success: true,
                message: "Active stolen alert already exists",
                alert: existingAlert,
                nearbyPolice: nearbyPolice,
                vehicleLocation: {
                    latitude: alertLat,
                    longitude: alertLng
                },
                alreadyReported: true
            });
        }

        // Create new stolen alert
        const stolenAlert = await Alert.create({
            voiture_id: vehicleId,
            alert_type: 'stolen',
            message: `🚨 VEHICLE REPORTED STOLEN - Engine disabled at ${new Date().toLocaleString()}`,
            alerted_at: new Date(),
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            alert_status: 'ACTIVE',
            sent: false,
            read: false
        });

        console.log("✅ Stolen alert created successfully:", stolenAlert.id);

        const nearbyPolice = await findNearbyPolice(latitude, longitude);

        console.log(`🚔 Found ${nearbyPolice.length} nearby police stations`);

        return res.status(201).json({
            success: true,
            message: "Vehicle reported as stolen successfully",
            alert: stolenAlert,
            nearbyPolice: nearbyPolice,
            vehicleLocation: {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude)
            }
        });

    } catch (error) {
        console.error("🔥 Error reporting stolen vehicle:", error);
        console.error("🔥 Stack trace:", error.stack);
        return res.status(500).json({
            success: false,
            message: "Server error while reporting stolen vehicle",
            error: error.message
        });
    }
};

// Helper function to find nearby police
async function findNearbyPolice(latitude, longitude, radiusMeters = 5000) {
    try {
        const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyBn88TP5X-xaRCYo5gYxvGnVy_0WYotZWo';

        const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

        const response = await axios.get(url, {
            params: {
                location: `${latitude},${longitude}`,
                radius: radiusMeters,
                type: 'police',
                key: GOOGLE_MAPS_API_KEY
            },
            timeout: 10000
        });

        console.log(`📡 Google Places API status: ${response.data.status}`);

        if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
            console.error('❌ Google Places API error:', response.data.status);
            return [];
        }

        if (!response.data.results || response.data.results.length === 0) {
            console.log('⚠️ No police stations found nearby');
            return [];
        }

        const policeStations = response.data.results.slice(0, 5).map(place => ({
            name: place.name,
            address: place.vicinity,
            latitude: place.geometry.location.lat,
            longitude: place.geometry.location.lng,
            placeId: place.place_id,
            rating: place.rating || null,
            isOpen: place.opening_hours?.open_now ?? null,
            distance: calculateDistance(
                latitude,
                longitude,
                place.geometry.location.lat,
                place.geometry.location.lng
            )
        }));

        policeStations.sort((a, b) => a.distance - b.distance);

        console.log(`✅ Formatted ${policeStations.length} police stations`);
        return policeStations;

    } catch (error) {
        console.error('🔥 Error finding nearby police:', error.message);
        return [];
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return parseFloat(distance.toFixed(2));
}

function toRad(degrees) {
    return degrees * (Math.PI / 180);
}

// ========== GET ACTIVE STOLEN ALERT ==========
exports.getActiveStolenAlert = async (req, res) => {
    try {
        const { vehicleId } = req.params;

        const alert = await Alert.findOne({
            where: {
                voiture_id: vehicleId,
                alert_type: 'stolen',
                alert_status: 'ACTIVE'
            },
            order: [['alerted_at', 'DESC']]
        });

        if (!alert) {
            return res.json({
                success: true,
                hasActiveAlert: false,
                alert: null
            });
        }

        res.json({
            success: true,
            hasActiveAlert: true,
            alert
        });

    } catch (error) {
        console.error("🔥 Error fetching stolen alert:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching stolen alert",
            error: error.message
        });
    }
};

// ========== RESOLVE STOLEN ALERT ==========
exports.resolveStolenAlert = async (req, res) => {
    try {
        const { id } = req.params;

        const alert = await Alert.findByPk(id);

        if (!alert) {
            return res.status(404).json({
                success: false,
                message: "Alert not found"
            });
        }

        if (alert.alert_type !== 'stolen') {
            return res.status(400).json({
                success: false,
                message: "This is not a stolen alert"
            });
        }

        alert.alert_status = 'RESOLVED';
        alert.read = true;
        await alert.save();

        console.log(`✅ Stolen alert ${id} resolved`);

        res.json({
            success: true,
            message: "Stolen alert resolved",
            alert
        });

    } catch (error) {
        console.error("🔥 Error resolving stolen alert:", error);
        res.status(500).json({
            success: false,
            message: "Error resolving stolen alert",
            error: error.message
        });
    }
};