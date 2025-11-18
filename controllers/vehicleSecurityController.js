// controllers/vehicleSecurityController.js
const VehicleSecurity = require('../models/vehicleSecurity');
const Voiture = require('../models/voiture');
const Location = require('../models/location');

/**
 * Toggle the vehicle security (on/off) and store parked location
 */
const toggleVehicleSecurity = async (req, res) => {
    const { voitureId } = req.params;

    console.log("🔐 Toggle security request for vehicle:", voitureId);

    try {
        // Step 1: ✅ Fetch voiture details (to get mac_id_gps)
        const voiture = await Voiture.findByPk(voitureId);
        if (!voiture) {
            return res.status(404).json({ error: 'Vehicle not found.' });
        }

        // Step 2: ✅ Fetch latest location based on mac_id_gps
        const latestLocation = await Location.findOne({
            where: { mac_id_gps: voiture.mac_id_gps },
            order: [['datetime', 'DESC']]  // using 'datetime' for latest GPS timestamp
        });

        if (!latestLocation) {
            return res.status(404).json({ error: 'No location data available for this vehicle.' });
        }

        // Step 3: ✅ Toggle security state
        let security = await VehicleSecurity.findOne({ where: { voiture_id: voitureId } });

        if (!security) {
            console.log("🆕 Creating new security entry for vehicle...");
            security = await VehicleSecurity.create({
                voiture_id: voitureId,
                is_active: true,
                parked_latitude: latestLocation.latitude,
                parked_longitude: latestLocation.longitude,
                activated_at: new Date()
            });
            return res.status(201).json({ message: "Security activated", security });
        }

        const newStatus = !security.is_active;
        console.log(`🚨 Setting security to ${newStatus ? 'ACTIVE' : 'INACTIVE'} for vehicle ID:`, voitureId);

        await security.update({
            is_active: newStatus,
            parked_latitude: newStatus ? latestLocation.latitude : null,
            parked_longitude: newStatus ? latestLocation.longitude : null,
            activated_at: newStatus ? new Date() : null
        });

        res.json({ message: `Security ${newStatus ? 'activated' : 'deactivated'}`, security });
    } catch (error) {
        console.error("❌ Error toggling vehicle security:", error);
        res.status(500).json({ error: 'Server error', details: error.message });
    }
};

const getSecurityStatus = async (req, res) => {
    const { voitureId } = req.params;
    const security = await VehicleSecurity.findOne({
        where: { voiture_id: voitureId }
    });
    if (!security) {
        return res.json({
            security: { is_active: false, voiture_id: voitureId }
        });
    }
    res.json({ security });
};

module.exports = {
    toggleVehicleSecurity,
    getSecurityStatus
};
