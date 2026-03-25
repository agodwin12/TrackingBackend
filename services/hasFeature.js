// services/hasFeature.js
const { Op }           = require('sequelize');
const Subscription     = require('../models/subscription');
const SubscriptionPlan = require('../models/subscriptionPlan');
const redisClient      = require('../config/redis');
const logger           = require('../utils/logger');

const CACHE_TTL_SECONDS = 300;
const CACHE_KEY = (vehicleId) => `sub:features:${vehicleId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Internal: parse the features value returned by Sequelize.
//
// The features column is a MySQL SET — Sequelize returns it as a
// comma-separated string e.g. 'live_tracking,geofence,trip_history'.
// This helper normalizes it to a plain string[] regardless of what
// Sequelize hands back.
// ─────────────────────────────────────────────────────────────────────────────
function _parseFeatures(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') return value.split(',').filter(Boolean);
    return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: load active features for a vehicle from DB
// ─────────────────────────────────────────────────────────────────────────────
async function _loadFeaturesFromDb(vehicleId) {
    const subscription = await Subscription.findOne({
        where: {
            vehicle_id: vehicleId,
            status:     'ACTIVE',
            end_date:   { [Op.gt]: new Date() },
        },
        include: [{
            model:      SubscriptionPlan,
            as:         'plan',
            attributes: ['features'],
        }],
        order: [['end_date', 'DESC']],
    });

    if (!subscription || !subscription.plan) return [];
    return _parseFeatures(subscription.plan.features);
}

// ─────────────────────────────────────────────────────────────────────────────
// getVehicleFeatures(vehicleId) → string[]
// Returns the full list of features the vehicle's active subscription unlocks.
// Result is Redis-cached for CACHE_TTL_SECONDS.
// ─────────────────────────────────────────────────────────────────────────────
async function getVehicleFeatures(vehicleId) {
    const cacheKey = CACHE_KEY(vehicleId);

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached !== null) return JSON.parse(cached);
    } catch (err) {
        logger.warn(`hasFeature: Redis GET failed for ${cacheKey}`, err.message);
    }

    const features = await _loadFeaturesFromDb(vehicleId);

    try {
        await redisClient.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(features));
    } catch (err) {
        logger.warn(`hasFeature: Redis SET failed for ${cacheKey}`, err.message);
    }

    return features;
}

// ─────────────────────────────────────────────────────────────────────────────
// hasFeature(vehicleId, feature) → boolean
// ─────────────────────────────────────────────────────────────────────────────
async function hasFeature(vehicleId, feature) {
    try {
        const features = await getVehicleFeatures(vehicleId);
        return features.includes(feature);
    } catch (err) {
        logger.error(`hasFeature: unexpected error for vehicle ${vehicleId}`, err.message);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// invalidateVehicleFeatureCache(vehicleId)
// Call from webhook after subscription activation or expiry.
// ─────────────────────────────────────────────────────────────────────────────
async function invalidateVehicleFeatureCache(vehicleId) {
    try {
        await redisClient.del(CACHE_KEY(vehicleId));
        logger.info(`hasFeature: cache invalidated for vehicle ${vehicleId}`);
    } catch (err) {
        logger.warn(`hasFeature: cache invalidation failed for vehicle ${vehicleId}`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag constants
// ─────────────────────────────────────────────────────────────────────────────
const FEATURES = {
    LIVE_TRACKING:  'live_tracking',
    GEOFENCE:       'geofence',
    SAFE_ZONE:      'safe_zone',
    TRIP_HISTORY:   'trip_history',
    ENGINE_CONTROL: 'engine_control',
    REPORT_STOLEN:  'report_stolen',
    CALL_CENTER:    'call_center',
};

module.exports = { hasFeature, getVehicleFeatures, invalidateVehicleFeatureCache, FEATURES };