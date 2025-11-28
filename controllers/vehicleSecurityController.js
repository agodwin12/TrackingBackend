// controllers/vehicleSecurityController.js
const VehicleSecurity = require('../models/vehicleSecurity');
const Voiture = require('../models/voiture');
const Location = require('../models/location');
const sequelize = require('../config/database');

/**
 * Toggle the vehicle security (on/off) and store parked location
 */
const toggleVehicleSecurity = async (req, res) => {
    const { voitureId } = req.params;

    console.log("🔐 Toggle security request for vehicle:", voitureId);

    try {
        // Step 1: ✅ Fetch voiture details using raw query
        console.log("📥 Step 1: Fetching vehicle details...");
        const [voitures] = await sequelize.query(
            'SELECT id, mac_id_gps, model FROM voitures WHERE id = ?',
            {
                replacements: [voitureId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!voitures) {
            console.error("❌ Vehicle not found:", voitureId);
            return res.status(404).json({ error: 'Vehicle not found.' });
        }

        console.log("✅ Vehicle found:");
        console.log("   ID:", voitures.id);
        console.log("   MAC ID:", voitures.mac_id_gps);
        console.log("   Model:", voitures.model);

        // Step 2: ✅ Fetch latest location using raw query
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
            return res.status(404).json({ error: 'No location data available for this vehicle.' });
        }

        console.log("✅ Latest location found:");
        console.log("   Latitude:", latestLocation.latitude);
        console.log("   Longitude:", latestLocation.longitude);
        console.log("   Datetime:", latestLocation.datetime);

        // Step 3: ✅ Check existing security record using raw query
        console.log("📥 Step 3: Checking existing security record...");
        const [security] = await sequelize.query(
            'SELECT id, voiture_id, is_active FROM vehicle_security WHERE voiture_id = ? LIMIT 1',
            {
                replacements: [voitureId],
                type: sequelize.QueryTypes.SELECT
            }
        );

        if (!security) {
            console.log("🆕 No existing security record found. Creating new one...");

            // Insert new security record using raw query
            await sequelize.query(
                `INSERT INTO vehicle_security 
                (voiture_id, is_active, parked_latitude, parked_longitude, activated_at, createdAt, updatedAt) 
                VALUES (?, 1, ?, ?, NOW(), NOW(), NOW())`,
                {
                    replacements: [voitureId, latestLocation.latitude, latestLocation.longitude]
                }
            );

            console.log("✅ New security record created");

            return res.status(201).json({
                success: true,
                message: "Security activated"
            });
        }

        console.log("✅ Existing security record found:");
        console.log("   ID:", security.id);
        console.log("   Current status:", security.is_active ? "ACTIVE" : "INACTIVE");

        const newStatus = security.is_active ? 0 : 1;
        console.log(`🔄 Toggling security to: ${newStatus ? 'ACTIVE' : 'INACTIVE'}`);

        // Update security record using raw query
        if (newStatus === 1) {
            // Activating security
            await sequelize.query(
                `UPDATE vehicle_security 
                SET is_active = 1, 
                    parked_latitude = ?, 
                    parked_longitude = ?, 
                    activated_at = NOW(), 
                    updatedAt = NOW() 
                WHERE id = ?`,
                {
                    replacements: [latestLocation.latitude, latestLocation.longitude, security.id]
                }
            );
        } else {
            // Deactivating security
            await sequelize.query(
                `UPDATE vehicle_security 
                SET is_active = 0, 
                    parked_latitude = NULL, 
                    parked_longitude = NULL, 
                    activated_at = NULL, 
                    updatedAt = NOW() 
                WHERE id = ?`,
                {
                    replacements: [security.id]
                }
            );
        }

        console.log("✅ Security record updated successfully");
        console.log("   New status:", newStatus ? "ACTIVE" : "INACTIVE");
        console.log("   Parked location:",
            newStatus ? `${latestLocation.latitude}, ${latestLocation.longitude}` : "NULL"
        );

        res.json({
            success: true,
            message: `Security ${newStatus ? 'activated' : 'deactivated'}`,
            security: {
                is_active: newStatus
            }
        });

    } catch (error) {
        console.error("❌ ========== ERROR IN TOGGLE SECURITY ==========");
        console.error("❌ Error message:", error.message);
        console.error("❌ Error stack:", error.stack);
        console.error("❌ ================================================");
        res.status(500).json({
            success: false,
            error: 'Server error',
            details: error.message
        });
    }
};

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

        res.json({
            success: true,
            security
        });
    } catch (error) {
        console.error("❌ Error getting security status:", error);
        res.status(500).json({
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