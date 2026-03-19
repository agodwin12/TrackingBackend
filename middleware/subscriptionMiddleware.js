// middleware/subscriptionMiddleware.js
const { hasFeature, FEATURES } = require('../services/hasFeature');
const logger = require('../utils/logger');


function requireFeature(feature) {
    return async (req, res, next) => {
        try {
            const vehicleId =
                req.params?.vehicleId   ||
                req.params?.voitureId   ||
                req.params?.vehicle_id  ||
                req.body?.vehicleId     ||
                req.body?.vehicle_id    ||
                req.query?.vehicleId    ||
                req.query?.vehicle_id;

            if (!vehicleId) {
                logger.warn(`subscriptionMiddleware: vehicle_id missing — route ${req.path}`);
                return res.status(400).json({
                    success: false,
                    message: 'vehicle_id is required',
                });
            }

            const allowed = await hasFeature(vehicleId, feature);

            if (!allowed) {
                logger.info(
                    `subscriptionMiddleware: vehicle ${vehicleId} blocked — '${feature}' not in plan`
                );
                return res.status(403).json({
                    success: false,
                    code:    'FEATURE_NOT_SUBSCRIBED',
                    message: 'Your current subscription does not include this feature.',
                    feature,
                });
            }

            next();
        } catch (err) {
            logger.error(`subscriptionMiddleware: error on ${req.path}`, err.message);
            return res.status(500).json({
                success: false,
                message: 'Subscription check failed. Please try again.',
            });
        }
    };
}

module.exports = { requireFeature, FEATURES };