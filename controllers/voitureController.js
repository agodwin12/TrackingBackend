// controllers/voitureController.js
const { Op }                             = require('sequelize');
const User                               = require('../models/userModel');
const Voiture                            = require('../models/voiture');
const Subscription                       = require('../models/subscription');
const AssociationUserVoiture             = require('../models/AssociationUserVoiture');
const AssociationChauffeurVoiturePartner = require('../models/associationChauffeurVoiturePartner');
const logger                             = require('../utils/logger');

// Must stay in sync with authController.js
const VOITURE_ATTRIBUTES = [
    'id',
    'voiture_unique_id',
    'immatriculation',
    'mac_id_gps',
    'marque',
    'model',
    'couleur',
    'photo',
    'nickname',
    'latitude',
    'longitude',
];

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS  (mirrors authController exactly)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRegularUserVehicles(userId) {
    const rows = await AssociationUserVoiture.findAll({
        where:   { user_id: userId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
    });
    return rows.map(r => r.voiture).filter(v => v !== null);
}

async function fetchChauffeurVehicles(chauffeurId) {
    const rows = await AssociationChauffeurVoiturePartner.findAll({
        where:   { chauffeur_id: chauffeurId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
        order:   [['assigned_at', 'DESC']],
    });
    return rows.map(r => r.voiture).filter(v => v !== null);
}

async function fetchVehicleSubscriptionMap(userId, vehicleIds) {
    if (!vehicleIds || vehicleIds.length === 0) return new Map();

    const now = new Date();

    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`🔍 [SUB MAP] Checking subscriptions (getUserVehicles)`);
    logger.info(`   userId     : ${userId}`);
    logger.info(`   vehicleIds : [${vehicleIds.join(', ')}]`);
    logger.info(`   now (UTC)  : ${now.toISOString()}`);

    // Step A — fetch ALL rows to diagnose issues
    const allSubs = await Subscription.findAll({
        where: {
            user_id:    userId,
            vehicle_id: { [Op.in]: vehicleIds },
        },
        attributes: ['id', 'vehicle_id', 'status', 'end_date', 'user_id'],
    });

    logger.info(`\n📋 [SUB MAP] ALL rows (no filter) — found ${allSubs.length}:`);
    if (allSubs.length === 0) {
        logger.warn(`   ⚠️  NONE — no subscription rows for user_id=${userId} + these vehicle_ids`);
    } else {
        allSubs.forEach(s => {
            const endDate    = s.end_date ? new Date(s.end_date) : null;
            const notExpired = endDate ? endDate > now : false;
            const statusOk   = s.status === 'ACTIVE';
            logger.info(
                `   id=${s.id} | vehicle_id=${s.vehicle_id} | ` +
                `status="${s.status}" (==='ACTIVE': ${statusOk}) | ` +
                `end_date=${endDate ? endDate.toISOString() : 'NULL'} | ` +
                `end_date > now: ${notExpired}`
            );
            if (!statusOk)      logger.warn(`   ❌ BLOCKED: status="${s.status}", expected "ACTIVE"`);
            if (endDate === null) logger.warn(`   ❌ BLOCKED: end_date is NULL`);
            else if (!notExpired) logger.warn(`   ❌ BLOCKED: end_date is in the past`);
        });
    }

    // Step B — apply the real filter
    const activeSubs = await Subscription.findAll({
        where: {
            user_id:    userId,
            vehicle_id: { [Op.in]: vehicleIds },
            status:     'ACTIVE',
            end_date:   { [Op.gt]: now },
        },
        attributes: ['id', 'vehicle_id', 'status', 'end_date'],
    });

    logger.info(`\n✅ [SUB MAP] After filter — found ${activeSubs.length}:`);
    activeSubs.forEach(s => {
        logger.info(`   id=${s.id} | vehicle_id=${s.vehicle_id} | end_date=${new Date(s.end_date).toISOString()}`);
    });

    const activeSet = new Set(activeSubs.map(s => Number(s.vehicle_id)));

    const map = new Map();
    for (const id of vehicleIds) {
        const result = activeSet.has(Number(id));
        map.set(id, result);
        logger.info(`   📌 vehicle ${id} → has_active_subscription = ${result}`);
    }

    logger.info(`${'─'.repeat(60)}\n`);
    return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/voitures/user/:user_id
// Returns the same vehicle + subscription payload as the login endpoint.
// Called by the dashboard after a successful payment to refresh state without
// requiring the user to log out and back in.
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserVehicles = async (req, res) => {
    try {
        const userId = Number(req.params.user_id);

        if (!userId || userId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        // Determine user type so we use the correct association table
        const user = await User.findByPk(userId, {
            attributes: ['id', 'partner_id'],
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isChauffeur = user.partner_id !== null && user.partner_id !== undefined;

        const vehicles = isChauffeur
            ? await fetchChauffeurVehicles(userId)
            : await fetchRegularUserVehicles(userId);

        if (vehicles.length === 0) {
            return res.status(404).json({ success: false, message: 'No vehicles found' });
        }

        logger.info(`🚗 getUserVehicles — user ${userId} (${isChauffeur ? 'chauffeur' : 'regular'}) | ${vehicles.length} vehicle(s)`);

        const vehicleIds      = vehicles.map(v => v.id);
        const subscriptionMap = await fetchVehicleSubscriptionMap(userId, vehicleIds);

        const vehiclesWithSubscription = vehicles.map(v => ({
            ...v.toJSON(),
            has_active_subscription: subscriptionMap.get(Number(v.id)) ?? false,
        }));

        const activeCount = vehiclesWithSubscription.filter(v => v.has_active_subscription).length;
        logger.info(`✅ getUserVehicles — ${activeCount}/${vehicles.length} vehicle(s) with active subscription`);

        return res.json({
            success:  true,
            vehicles: vehiclesWithSubscription,
        });

    } catch (error) {
        logger.error('🔥 getUserVehicles error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server error',
            error:   error.message,
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vehicles/:vehicleId/nickname
// ─────────────────────────────────────────────────────────────────────────────
exports.updateVehicleNickname = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { nickname }  = req.body;

        if (nickname && nickname.length > 50) {
            return res.status(400).json({
                success: false,
                message: 'Nickname must be 50 characters or less',
            });
        }

        const vehicle = await Voiture.findByPk(vehicleId);

        if (!vehicle) {
            return res.status(404).json({ success: false, message: 'Vehicle not found' });
        }

        await vehicle.update({ nickname: nickname || null });

        logger.info(`✅ Nickname updated — vehicle ${vehicleId}`);

        return res.json({
            success: true,
            message: 'Nickname updated successfully',
            vehicle: {
                id:              vehicle.id,
                immatriculation: vehicle.immatriculation,
                marque:          vehicle.marque,
                model:           vehicle.model,
                nickname:        vehicle.nickname,
            },
        });

    } catch (error) {
        logger.error('🔥 updateVehicleNickname error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server error',
            error:   error.message,
        });
    }
};