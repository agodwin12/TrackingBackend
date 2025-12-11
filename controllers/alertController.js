// controllers/alertController.js

const { Alert, Voiture } = require("../models");
const { Op } = require("sequelize");

/**
 * Get alerts for a specific vehicle with pagination and filters
 * GET /api/alerts/vehicle/:vehicleId
 */
exports.getAlertsByVehicle = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const {
            page = 1,
            limit = 20,
            alertType,      // Filter by type: 'geofence', 'safe_zone', 'speed', 'time_zone', 'engine'
            read,           // Filter by read status: true/false
            status,         // Filter by alert_status: 'ACTIVE', 'RESOLVED', 'FALSE_ALARM'
            startDate,      // Filter from date
            endDate         // Filter to date
        } = req.query;

        console.log(`\n📌 [getAlertsByVehicle] Vehicle ID: ${vehicleId}`);
        console.log(`➡ Pagination: page=${page}, limit=${limit}`);
        console.log(`➡ Filters:`, { alertType, read, status, startDate, endDate });

        // Build where clause
        const whereClause = { voiture_id: vehicleId };

        // Filter by alert type
        if (alertType) {
            whereClause.alert_type = alertType;
        }

        // Filter by read status
        if (read !== undefined) {
            whereClause.read = read === 'true';
        }

        // Filter by alert status
        if (status) {
            whereClause.alert_status = status;
        }

        // Filter by date range
        if (startDate || endDate) {
            whereClause.alerted_at = {};
            if (startDate) {
                whereClause.alerted_at[Op.gte] = new Date(startDate);
            }
            if (endDate) {
                const endDatePlusOne = new Date(endDate);
                endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
                whereClause.alerted_at[Op.lt] = endDatePlusOne;
            }
        }

        // Calculate offset
        const offset = (page - 1) * limit;

        // Fetch alerts with pagination
        const result = await Alert.findAndCountAll({
            where: whereClause,
            order: [["alerted_at", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset),
            attributes: [
                'id',
                'voiture_id',
                'alert_type',
                'message',
                'alerted_at',
                'sent',
                'read',
                'processed',
                'latitude',
                'longitude',
                'alert_status',
                'created_at'
            ]
        });

        const totalPages = Math.ceil(result.count / limit);

        console.log(`✅ Fetched ${result.rows.length} alerts (Total: ${result.count})`);

        return res.status(200).json({
            success: true,
            data: {
                alerts: result.rows,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages,
                    totalAlerts: result.count,
                    alertsPerPage: parseInt(limit),
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        });

    } catch (error) {
        console.error("🔥 Error fetching alerts:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching alerts",
            error: error.message
        });
    }
};

/**
 * Get all alerts across all vehicles (admin view) with pagination
 * GET /api/alerts
 */
exports.getAllAlerts = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            alertType,
            read,
            status,
            startDate,
            endDate
        } = req.query;

        console.log(`\n📌 [getAllAlerts] Request received`);
        console.log(`➡ Pagination: page=${page}, limit=${limit}`);

        // Build where clause
        const whereClause = {};

        if (alertType) {
            whereClause.alert_type = alertType;
        }

        if (read !== undefined) {
            whereClause.read = read === 'true';
        }

        if (status) {
            whereClause.alert_status = status;
        }

        if (startDate || endDate) {
            whereClause.alerted_at = {};
            if (startDate) {
                whereClause.alerted_at[Op.gte] = new Date(startDate);
            }
            if (endDate) {
                const endDatePlusOne = new Date(endDate);
                endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
                whereClause.alerted_at[Op.lt] = endDatePlusOne;
            }
        }

        const offset = (page - 1) * limit;

        const result = await Alert.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: Voiture,
                    as: 'vehicle',
                    attributes: ['id', 'immatriculation', 'marque', 'model', 'nickname']
                }
            ],
            order: [["alerted_at", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        const totalPages = Math.ceil(result.count / limit);

        console.log(`✅ Fetched ${result.rows.length} alerts (Total: ${result.count})`);

        return res.status(200).json({
            success: true,
            data: {
                alerts: result.rows,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages,
                    totalAlerts: result.count,
                    alertsPerPage: parseInt(limit),
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        });

    } catch (error) {
        console.error("🔥 Error fetching all alerts:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching alerts",
            error: error.message
        });
    }
};

/**
 * Get unread alert count for a vehicle
 * GET /api/alerts/vehicle/:vehicleId/unread-count
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const { vehicleId } = req.params;

        const count = await Alert.count({
            where: {
                voiture_id: vehicleId,
                read: false
            }
        });

        return res.status(200).json({
            success: true,
            data: {
                vehicleId: parseInt(vehicleId),
                unreadCount: count
            }
        });

    } catch (error) {
        console.error("🔥 Error fetching unread count:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching unread count",
            error: error.message
        });
    }
};

/**
 * Get alert statistics for a vehicle
 * GET /api/alerts/vehicle/:vehicleId/stats
 */
exports.getAlertStats = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate } = req.query;

        console.log(`\n📌 [getAlertStats] Vehicle ID: ${vehicleId}`);

        const whereClause = { voiture_id: vehicleId };

        if (startDate || endDate) {
            whereClause.alerted_at = {};
            if (startDate) {
                whereClause.alerted_at[Op.gte] = new Date(startDate);
            }
            if (endDate) {
                const endDatePlusOne = new Date(endDate);
                endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
                whereClause.alerted_at[Op.lt] = endDatePlusOne;
            }
        }

        // Get counts by type
        const totalAlerts = await Alert.count({ where: whereClause });

        const geofenceCount = await Alert.count({
            where: { ...whereClause, alert_type: 'geofence' }
        });

        const safeZoneCount = await Alert.count({
            where: { ...whereClause, alert_type: 'safe_zone' }
        });

        const speedCount = await Alert.count({
            where: { ...whereClause, alert_type: 'speed' }
        });

        const timeZoneCount = await Alert.count({
            where: { ...whereClause, alert_type: 'time_zone' }
        });

        const unreadCount = await Alert.count({
            where: { ...whereClause, read: false }
        });

        console.log(`✅ Stats calculated for vehicle ${vehicleId}`);

        return res.status(200).json({
            success: true,
            data: {
                vehicleId: parseInt(vehicleId),
                totalAlerts,
                unreadAlerts: unreadCount,
                byType: {
                    geofence: geofenceCount,
                    safeZone: safeZoneCount,
                    speed: speedCount,
                    timeZone: timeZoneCount
                }
            }
        });

    } catch (error) {
        console.error("🔥 Error fetching alert stats:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching alert stats",
            error: error.message
        });
    }
};

/**
 * Mark single alert as read
 * PATCH /api/alerts/:id/read
 */
exports.markAlertAsRead = async (req, res) => {
    try {
        const { id } = req.params;

        const alert = await Alert.findByPk(id);

        if (!alert) {
            return res.status(404).json({
                success: false,
                message: "Alert not found"
            });
        }

        alert.read = true;
        await alert.save();

        console.log(`✅ Alert ${id} marked as read`);

        return res.status(200).json({
            success: true,
            message: "Alert marked as read",
            data: alert
        });

    } catch (error) {
        console.error("🔥 Error marking alert as read:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while updating alert",
            error: error.message
        });
    }
};

/**
 * Mark all alerts as read for a vehicle
 * PATCH /api/alerts/vehicle/:vehicleId/read-all
 */
exports.markAllAsRead = async (req, res) => {
    try {
        const { vehicleId } = req.params;

        const [count] = await Alert.update(
            { read: true },
            {
                where: {
                    voiture_id: vehicleId,
                    read: false  // Only update unread alerts
                }
            }
        );

        console.log(`✅ ${count} alerts marked as read for vehicle ${vehicleId}`);

        return res.status(200).json({
            success: true,
            message: `${count} alert(s) marked as read`
        });

    } catch (error) {
        console.error("🔥 Error marking all alerts as read:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while marking alerts as read",
            error: error.message
        });
    }
};

/**
 * Delete old read alerts (cleanup)
 * DELETE /api/alerts/cleanup
 */
exports.cleanupOldAlerts = async (req, res) => {
    try {
        const { daysOld = 30 } = req.query;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(daysOld));

        const count = await Alert.destroy({
            where: {
                read: true,
                alerted_at: {
                    [Op.lt]: cutoffDate
                },
                alert_status: {
                    [Op.or]: [null, 'RESOLVED', 'FALSE_ALARM']
                }
            }
        });

        console.log(`✅ Deleted ${count} old alerts (older than ${daysOld} days)`);

        return res.status(200).json({
            success: true,
            message: `Deleted ${count} old alert(s)`,
            deletedCount: count
        });

    } catch (error) {
        console.error("🔥 Error cleaning up alerts:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while cleaning up alerts",
            error: error.message
        });
    }
};

/**
 * Report stolen vehicle
 * POST /api/alerts/stolen/report
 */
exports.reportStolenVehicle = async (req, res) => {
    try {
        console.log("🚨 [REPORT STOLEN] Request received");
        console.log("📝 Request Body:", req.body);

        const { vehicleId, userId, latitude, longitude } = req.body;

        if (!vehicleId || !userId) {
            console.error("❌ Validation failed: Missing required fields");
            return res.status(400).json({
                success: false,
                message: "Vehicle ID and User ID are required"
            });
        }

        console.log(`🚨 Reporting vehicle ${vehicleId} as STOLEN by user ${userId}`);

        // Check for existing active stolen alert
        const existingAlert = await Alert.findOne({
            where: {
                voiture_id: vehicleId,
                alert_type: 'stolen',
                alert_status: 'ACTIVE'
            }
        });

        if (existingAlert) {
            console.log("⚠️ Active stolen alert already exists");
            return res.status(400).json({
                success: false,
                message: "This vehicle already has an active stolen alert",
                alert: existingAlert
            });
        }

        // Create stolen alert
        const stolenAlert = await Alert.create({
            voiture_id: vehicleId,
            alert_type: 'stolen',
            message: `🚨 VEHICLE REPORTED STOLEN - Engine has been disabled remotely`,
            alerted_at: new Date(),
            latitude: latitude || null,
            longitude: longitude || null,
            alert_status: 'ACTIVE',
            sent: false,
            read: false
        });

        console.log("✅ Stolen alert created successfully");

        return res.status(201).json({
            success: true,
            message: "Vehicle reported as stolen successfully",
            alert: stolenAlert
        });

    } catch (error) {
        console.error("🔥 Error reporting stolen vehicle:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while reporting stolen vehicle",
            error: error.message
        });
    }
};

/**
 * Get active stolen alert for vehicle
 * GET /api/alerts/stolen/vehicle/:vehicleId
 */
exports.getActiveStolenAlert = async (req, res) => {
    try {
        const { vehicleId } = req.params;

        const stolenAlert = await Alert.findOne({
            where: {
                voiture_id: vehicleId,
                alert_type: 'stolen',
                alert_status: 'ACTIVE'
            },
            order: [['alerted_at', 'DESC']]
        });

        if (!stolenAlert) {
            return res.status(404).json({
                success: false,
                message: "No active stolen alert for this vehicle"
            });
        }

        return res.status(200).json({
            success: true,
            alert: stolenAlert
        });

    } catch (error) {
        console.error("🔥 Error fetching stolen alert:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching stolen alert",
            error: error.message
        });
    }
};

/**
 * Resolve stolen alert
 * PATCH /api/alerts/stolen/:id/resolve
 */
exports.resolveStolenAlert = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['RESOLVED', 'FALSE_ALARM'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid status. Must be 'RESOLVED' or 'FALSE_ALARM'"
            });
        }

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

        alert.alert_status = status;
        alert.read = true;
        await alert.save();

        console.log(`✅ Stolen alert ${id} marked as ${status}`);

        return res.status(200).json({
            success: true,
            message: `Alert marked as ${status}`,
            alert: alert
        });

    } catch (error) {
        console.error("🔥 Error resolving stolen alert:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while resolving alert",
            error: error.message
        });
    }
};

module.exports = exports;