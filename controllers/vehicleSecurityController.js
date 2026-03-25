// controllers/vehicleSecurityController.js
const VehicleSecurity = require('../models/vehicleSecurity');
const Voiture = require('../models/voiture');
const Location = require('../models/location');
const sequelize = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// toggleVehicleSecurity
// POST /api/vehicle/:voitureId/security/toggle
//
// FIX: replaced the SELECT-then-INSERT pattern with a single atomic
// INSERT ... ON DUPLICATE KEY UPDATE.  The old code had a TOCTOU race:
// two concurrent requests both saw no row and both tried to INSERT,
// causing a unique-constraint Validation error on the second one.
// MySQL's ON DUPLICATE KEY UPDATE resolves this atomically.
//
// PREREQUISITE: voiture_id must have a UNIQUE constraint on vehicle_security.
// If not already added, run once:
//   ALTER TABLE vehicle_security ADD UNIQUE KEY uq_voiture_id (voiture_id);
// ─────────────────────────────────────────────────────────────────────────────
const toggleVehicleSecurity = async (req, res) => {
    const { voitureId } = req.params;

    console.log("🔐 Toggle security request for vehicle:", voitureId);

    try {
        // ── Step 1: Fetch vehicle ────────────────────────────────────────────
        console.log("📥 Step 1: Fetching vehicle details...");
        const [voitures] = await sequelize.query(
            'SELECT id, mac_id_gps, model FROM voitures WHERE id = ? LIMIT 1',
            {
                replacements: [voitureId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voitures) {
            console.error("❌ Vehicle not found:", voitureId);
            return res.status(404).json({ success: false, error: 'Vehicle not found.' });
        }

        console.log("✅ Vehicle found:");
        console.log("   ID:", voitures.id);
        console.log("   MAC ID:", voitures.mac_id_gps);
        console.log("   Model:", voitures.model);

        // ── Step 2: Fetch latest location ────────────────────────────────────
        console.log("📥 Step 2: Fetching latest location for MAC ID:", voitures.mac_id_gps);
        const [latestLocation] = await sequelize.query(
            'SELECT latitude, longitude, datetime FROM locations WHERE mac_id_gps = ? ORDER BY datetime DESC LIMIT 1',
            {
                replacements: [voitures.mac_id_gps],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!latestLocation) {
            console.error("❌ No location data available for vehicle:", voitureId);
            return res.status(404).json({
                success: false,
                error: 'No location data available for this vehicle.'
            });
        }

        console.log("✅ Latest location found:");
        console.log("   Latitude:", latestLocation.latitude);
        console.log("   Longitude:", latestLocation.longitude);
        console.log("   Datetime:", latestLocation.datetime);

        // ── Step 3: Read current security state ──────────────────────────────
        // We still need the current is_active value so we can flip it.
        console.log("📥 Step 3: Checking existing security record...");
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            {
                replacements: [voitureId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        // Decide new state:
        //   no record yet  → activate (1)
        //   record exists  → flip current value
        const newStatus = security ? (security.is_active ? 0 : 1) : 1;

        console.log(
            security
                ? `🔄 Existing record (id=${security.id}, is_active=${security.is_active}) → toggling to ${newStatus}`
                : `🆕 No record found → creating with is_active=${newStatus}`
        );

        // ── Step 4: Upsert atomically ─────────────────────────────────────────
        // INSERT ... ON DUPLICATE KEY UPDATE is a single atomic MySQL statement.
        // The INSERT path runs on first call; subsequent calls hit the UPDATE
        // path. No window exists for a race condition.
        if (newStatus === 1) {
            // Activating — store current parked position
            await sequelize.query(
                `INSERT INTO vehicle_security
                    (voiture_id, is_active, parked_latitude, parked_longitude,
                     activated_at, createdAt, updatedAt)
                 VALUES (?, 1, ?, ?, NOW(), NOW(), NOW())
                 ON DUPLICATE KEY UPDATE
                    is_active        = 1,
                    parked_latitude  = VALUES(parked_latitude),
                    parked_longitude = VALUES(parked_longitude),
                    activated_at     = NOW(),
                    updatedAt        = NOW()`,
                {
                    replacements: [
                        voitureId,
                        latestLocation.latitude,
                        latestLocation.longitude
                    ]
                }
            );
        } else {
            // Deactivating — clear parked position
            await sequelize.query(
                `INSERT INTO vehicle_security
                    (voiture_id, is_active, parked_latitude, parked_longitude,
                     activated_at, createdAt, updatedAt)
                 VALUES (?, 0, NULL, NULL, NULL, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE
                    is_active        = 0,
                    parked_latitude  = NULL,
                    parked_longitude = NULL,
                    activated_at     = NULL,
                    updatedAt        = NOW()`,
                {
                    replacements: [voitureId]
                }
            );
        }

        console.log("✅ Security upserted successfully");
        console.log("   New status:", newStatus ? "ACTIVE" : "INACTIVE");
        console.log("   Parked location:",
            newStatus ? `${latestLocation.latitude}, ${latestLocation.longitude}` : "NULL"
        );

        return res.status(200).json({
            success: true,
            message: `Security ${newStatus ? 'activated' : 'deactivated'}`,
            security: {
                is_active: newStatus
            },
            statusCode: 200,
        });

    } catch (error) {
        console.error("❌ ========== ERROR IN TOGGLE SECURITY ==========");
        console.error("❌ Error message:", error.message);
        console.error("❌ Error stack:", error.stack);
        console.error("❌ ================================================");
        return res.status(500).json({
            success: false,
            error: 'Server error',
            details: error.message
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// getSecurityStatus
// GET /api/vehicle/:voitureId/security/status
// ─────────────────────────────────────────────────────────────────────────────
const getSecurityStatus = async (req, res) => {
    const { voitureId } = req.params;

    console.log("📥 Getting security status for vehicle:", voitureId);

    try {
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active, parked_latitude, parked_longitude FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            {
                replacements: [voitureId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!security) {
            console.log("⚠️ No security record found for vehicle:", voitureId);
            return res.json({
                success: true,
                security: {
                    is_active: false,
                    voiture_id: voitureId
                }
            });
        }

        console.log("✅ Security status retrieved:");
        console.log("   Active:", security.is_active ? "YES" : "NO");
        console.log("   Parked at:", security.parked_latitude, security.parked_longitude);

        return res.json({
            success: true,
            security
        });

    } catch (error) {
        console.error("❌ Error getting security status:", error);
        return res.status(500).json({
            success: false,
            error: 'Server error',
            details: error.message
        });
    }
};

module.exports = {
    toggleVehicleSecurity,
    getSecurityStatus
};