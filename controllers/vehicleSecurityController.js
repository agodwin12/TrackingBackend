// controllers/vehicleSecurityController.js

const VehicleSecurity = require('../models/vehicleSecurity');
const Voiture         = require('../models/voiture');
const Location        = require('../models/location');
const sequelize       = require('../config/database');
const { sendGpsCommandWithFallback } = require('../services/GpsService');
const notificationController = require('./notificationController');
const logger          = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Existing: Toggle the vehicle security (on/off) and store parked location
// ─────────────────────────────────────────────────────────────────────────────
const toggleVehicleSecurity = async (req, res) => {
    const { voitureId } = req.params;

    console.log("🔐 Toggle security request for vehicle:", voitureId);

    try {
        // Step 1: Fetch voiture details
        const [voitures] = await sequelize.query(
            'SELECT id, mac_id_gps, model FROM voitures WHERE id = ?',
            { replacements: [voitureId], type: sequelize.QueryTypes.SELECT }
        );

        if (!voitures) {
            console.error("❌ Vehicle not found:", voitureId);
            return res.status(404).json({ error: 'Vehicle not found.' });
        }

        // Step 2: Fetch latest location
        const [latestLocation] = await sequelize.query(
            'SELECT latitude, longitude, datetime FROM locations WHERE mac_id_gps = ? ORDER BY datetime DESC LIMIT 1',
            { replacements: [voitures.mac_id_gps], type: sequelize.QueryTypes.SELECT }
        );

        if (!latestLocation) {
            console.error("❌ No location data available for vehicle:", voitureId);
            return res.status(404).json({ error: 'No location data available for this vehicle.' });
        }

        // Step 3: Check existing security record
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            { replacements: [voitureId], type: sequelize.QueryTypes.SELECT }
        );

        if (!security) {
            // Create new security record
            await sequelize.query(
                `INSERT INTO vehicle_security 
                (voiture_id, is_active, parked_latitude, parked_longitude, activated_at, createdAt, updatedAt) 
                VALUES (?, 1, ?, ?, NOW(), NOW(), NOW())`,
                { replacements: [voitureId, latestLocation.latitude, latestLocation.longitude] }
            );

            return res.status(201).json({ success: true, message: "Security activated" });
        }

        const newStatus = security.is_active ? 0 : 1;

        if (newStatus === 1) {
            await sequelize.query(
                `UPDATE vehicle_security 
                SET is_active = 1, parked_latitude = ?, parked_longitude = ?, 
                    activated_at = NOW(), updatedAt = NOW() 
                WHERE id = ?`,
                { replacements: [latestLocation.latitude, latestLocation.longitude, security.id] }
            );
        } else {
            await sequelize.query(
                `UPDATE vehicle_security 
                SET is_active = 0, parked_latitude = NULL, parked_longitude = NULL, 
                    activated_at = NULL, updatedAt = NOW() 
                WHERE id = ?`,
                { replacements: [security.id] }
            );
        }

        res.json({
            success: true,
            message: `Security ${newStatus ? 'activated' : 'deactivated'}`,
            security: { is_active: newStatus }
        });

    } catch (error) {
        console.error("❌ Error in toggleVehicleSecurity:", error.message);
        res.status(500).json({ success: false, error: 'Server error', details: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Existing: Get security status
// ─────────────────────────────────────────────────────────────────────────────
const getSecurityStatus = async (req, res) => {
    const { voitureId } = req.params;

    console.log("📥 Getting security status for vehicle:", voitureId);

    try {
        const [security] = await sequelize.query(
            `SELECT id, voiture_id, is_active, parked_latitude, parked_longitude,
                    geofence_locked, geofence_locked_at, geofence_locked_by
             FROM vehicle_security WHERE voiture_id = ? LIMIT 1`,
            { replacements: [voitureId], type: sequelize.QueryTypes.SELECT }
        );

        if (!security) {
            return res.json({
                success: true,
                security: { is_active: false, voiture_id: voitureId, geofence_locked: false }
            });
        }

        res.json({ success: true, security });
    } catch (error) {
        console.error("❌ Error getting security status:", error);
        res.status(500).json({ success: false, error: 'Server error', details: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ✅ NEW: Geofence Unlock — manual re-open of engine after auto geofence cut
//
// POST /api/vehicles/:voitureId/geofence-unlock
//
// Authorization rules:
//   - Only the LEASE_PARTNER (the user whose id = driver's partner_id) can unlock.
//   - Admins (role_id = 1 or 2) can also unlock.
//   - The driver themselves CANNOT unlock.
//
// What it does:
//   1. Verifies the vehicle is actually geofence_locked.
//   2. Verifies the caller has permission.
//   3. Sends OPENRELAY to the GPS device.
//   4. Sets geofence_locked = 0.
//   5. Notifies the driver that they can ride again.
// ─────────────────────────────────────────────────────────────────────────────
const geofenceUnlock = async (req, res) => {
    const { voitureId } = req.params;
    const requestingUserId = req.user?.id;

    logger.info(`🔓 [GeofenceUnlock] Request for vehicle ${voitureId} by user ${requestingUserId}`);

    try {
        // ── Step 1: Fetch vehicle details ─────────────────────────────────────
        const [voiture] = await sequelize.query(
            `SELECT v.id, v.mac_id_gps, v.nickname, v.marque, v.model,
                    s.account_name
             FROM   voitures v
             JOIN   sim_gps  s ON s.mac_id = v.mac_id_gps
             WHERE  v.id = :voitureId
             ORDER  BY s.updated_at DESC
             LIMIT  1`,
            { replacements: { voitureId }, type: sequelize.QueryTypes.SELECT }
        );

        if (!voiture) {
            return res.status(404).json({ success: false, message: 'Vehicle not found.' });
        }

        // ── Step 2: Check vehicle_security record ─────────────────────────────
        const [security] = await sequelize.query(
            `SELECT id, geofence_locked, geofence_locked_at
             FROM vehicle_security WHERE voiture_id = :voitureId LIMIT 1`,
            { replacements: { voitureId }, type: sequelize.QueryTypes.SELECT }
        );

        if (!security) {
            return res.status(404).json({ success: false, message: 'No security record found for this vehicle.' });
        }

        if (!security.geofence_locked) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle engine is not locked by geofence. Nothing to unlock.'
            });
        }

        // ── Step 3: Authorization check ───────────────────────────────────────
        // Who is allowed to unlock?
        //   a) The LEASE_PARTNER (Frank William) — their id is the driver's partner_id
        //   b) An admin (role_id <= 2)
        const [requestingUser] = await sequelize.query(
            `SELECT id, role_id FROM users WHERE id = :userId LIMIT 1`,
            { replacements: { userId: requestingUserId }, type: sequelize.QueryTypes.SELECT }
        );

        if (!requestingUser) {
            return res.status(401).json({ success: false, message: 'Unauthorized.' });
        }

        const isAdmin = requestingUser.role_id <= 2;

        // Find the partner_id of the driver currently assigned to this vehicle
        const [assignmentRow] = await sequelize.query(
            `SELECT u.partner_id
             FROM   association_chauffeur_voiture_partner acvp
             JOIN   users u ON u.id = acvp.chauffeur_id
             WHERE  acvp.voiture_id = :voitureId
             ORDER  BY acvp.assigned_at DESC
             LIMIT  1`,
            { replacements: { voitureId }, type: sequelize.QueryTypes.SELECT }
        );

        const vehiclePartnerId = assignmentRow?.partner_id || null;
        const isVehiclePartner = vehiclePartnerId && (requestingUserId === vehiclePartnerId);

        if (!isAdmin && !isVehiclePartner) {
            logger.warn(
                `🚫 [GeofenceUnlock] User ${requestingUserId} is NOT authorized to unlock vehicle ${voitureId}. ` +
                `(vehiclePartnerId=${vehiclePartnerId}, isAdmin=${isAdmin})`
            );
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to unlock this vehicle. Only the fleet manager can do this.'
            });
        }

        // ── Step 4: Send OPENRELAY command to GPS device ──────────────────────
        logger.info(`📡 [GeofenceUnlock] Sending OPENRELAY to vehicle ${voitureId} (MAC: ${voiture.mac_id_gps})`);

        const cmdResult = await sendGpsCommandWithFallback({
            accountName: String(voiture.account_name).trim().toLowerCase(),
            macId:       voiture.mac_id_gps,
            command:     'OPENRELAY',
        });

        if (!cmdResult.ok) {
            logger.error(`❌ [GeofenceUnlock] OPENRELAY failed for vehicle ${voitureId}: ${cmdResult.message}`);
            return res.status(502).json({
                success: false,
                message: `GPS command failed: ${cmdResult.message || 'Unknown error'}. Please try again.`,
                retried: cmdResult.retried
            });
        }

        logger.info(`✅ [GeofenceUnlock] OPENRELAY succeeded for vehicle ${voitureId}`);

        // ── Step 5: Clear geofence_locked in DB ───────────────────────────────
        await sequelize.query(
            `UPDATE vehicle_security
             SET    geofence_locked    = 0,
                    geofence_locked_at = NULL,
                    geofence_locked_by = NULL,
                    updatedAt          = NOW()
             WHERE  voiture_id = :voitureId`,
            { replacements: { voitureId }, type: sequelize.QueryTypes.UPDATE }
        );

        logger.info(`🔓 [GeofenceUnlock] vehicle_security geofence_locked cleared for vehicle ${voitureId}`);

        // ── Step 6: Notify the driver ─────────────────────────────────────────
        const vehicleName = voiture.nickname || `${voiture.marque} ${voiture.model}`;

        const [driverRow] = await sequelize.query(
            `SELECT u.id AS driver_id, u.nom, u.prenom
             FROM   association_chauffeur_voiture_partner acvp
             JOIN   users u ON u.id = acvp.chauffeur_id
             WHERE  acvp.voiture_id = :voitureId
             ORDER  BY acvp.assigned_at DESC
             LIMIT  1`,
            { replacements: { voitureId }, type: sequelize.QueryTypes.SELECT }
        );

        if (driverRow?.driver_id) {
            try {
                await notificationController.sendToUser(driverRow.driver_id, {
                    title: '✅ Engine Re-enabled',
                    body:  `The engine of ${vehicleName} has been re-enabled by your fleet manager. You may continue your ride.`,
                    data:  {
                        type:       'geofence_engine_unlocked',
                        vehicleId:  String(voitureId),
                        vehicleName
                    }
                });
                logger.info(`📲 [GeofenceUnlock] Driver ${driverRow.driver_id} notified of unlock`);
            } catch (notifErr) {
                logger.error(`❌ [GeofenceUnlock] Driver notification failed: ${notifErr.message}`);
                // Do not fail the request over a notification error
            }
        }

        // ── Step 7: Respond ───────────────────────────────────────────────────
        return res.json({
            success: true,
            message:   `Engine for vehicle ${vehicleName} has been successfully re-enabled.`,
            vehicleId: voitureId,
            unlockedBy: requestingUserId,
            retried:   cmdResult.retried
        });

    } catch (error) {
        logger.error(`❌ [GeofenceUnlock] error: ${error.message}`);
        logger.error(error.stack);
        return res.status(500).json({ success: false, error: 'Server error', details: error.message });
    }
};

module.exports = {
    toggleVehicleSecurity,
    getSecurityStatus,
    geofenceUnlock          // ✅ new export
};