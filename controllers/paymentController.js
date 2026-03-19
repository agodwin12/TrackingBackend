// controllers/paymentController.js
const { initiateSubscriptionPayment, initiateSubscriptionPaymentBatch } = require('../services/paymentService');
const Payment = require('../models/payment');
const Subscription = require('../models/subscription');
const SubscriptionPlan = require('../models/subscriptionPlan');

/**
 * POST /api/payments/initiate
 * User initiates a payment for a single vehicle subscription
 */
const initiatePayment = async (req, res) => {
    try {
        const { vehicle_id, plan_id, method, provider, phone_number, country_code } = req.body;
        const user_id = req.user.id;

        // 1. Validate required fields
        if (!vehicle_id || !plan_id || !method) {
            return res.status(400).json({
                success: false,
                message: 'vehicle_id, plan_id and method are required'
            });
        }

        // 2. Validate method
        if (!['MOBILE_MONEY', 'CASH'].includes(method)) {
            return res.status(400).json({
                success: false,
                message: 'method must be MOBILE_MONEY or CASH'
            });
        }

        // 3. If mobile money, phone and provider are required
        if (method === 'MOBILE_MONEY' && (!phone_number || !provider)) {
            return res.status(400).json({
                success: false,
                message: 'phone_number and provider are required for MOBILE_MONEY'
            });
        }

        // 4. Call the payment service
        const result = await initiateSubscriptionPayment({
            user_id,
            vehicle_id,
            plan_id,
            method,
            provider,
            phone_number,
            country_code: country_code || null,
        });

        return res.status(200).json({
            success: true,
            message: 'Payment initiated successfully',
            data: result
        });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] initiatePayment error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'An error occurred while initiating payment'
        });
    }
};

/**
 * POST /api/payments/initiate-batch
 * User initiates a payment for multiple vehicles at once
 */
const initiatePaymentBatch = async (req, res) => {
    try {
        const { vehicle_ids, plan_id, method, provider, phone_number, country_code } = req.body;
        const user_id = req.user.id;

        // 1. Validate vehicle_ids
        if (!Array.isArray(vehicle_ids) || vehicle_ids.length === 0)
            return res.status(400).json({ success: false, message: 'vehicle_ids must be a non-empty array' });
        if (vehicle_ids.length > 20)
            return res.status(400).json({ success: false, message: 'Maximum 20 vehicles per batch' });

        // 2. Validate required fields
        if (!plan_id || !method)
            return res.status(400).json({ success: false, message: 'plan_id and method are required' });

        // 3. Validate method
        if (!['MOBILE_MONEY', 'CASH'].includes(method))
            return res.status(400).json({ success: false, message: 'method must be MOBILE_MONEY or CASH' });

        // 4. If mobile money, phone and provider are required
        if (method === 'MOBILE_MONEY' && (!phone_number || !provider))
            return res.status(400).json({ success: false, message: 'phone_number and provider are required for MOBILE_MONEY' });

        // 5. Call the payment service
        const result = await initiateSubscriptionPaymentBatch({
            user_id,
            vehicle_ids: vehicle_ids.map(Number),
            plan_id:     Number(plan_id),
            method,
            provider,
            phone_number,
            country_code: country_code || null,
        });

        return res.status(200).json({
            success: true,
            message: `Payment initiated for ${result.vehicle_count} vehicle(s)`,
            data: result,
        });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] initiatePaymentBatch error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/payments/history
 * Get full payment history for the logged in user, enriched with vehicle data.
 */
const getPaymentHistory = async (req, res) => {
    try {
        const user_id  = req.user.id;
        const sequelize = require('../config/database');

        // Raw JOIN so we get vehicle name/plate without needing a model association
        const rows = await sequelize.query(
            `SELECT
                 p.id,
                 p.vehicle_id,
                 p.plan_id,
                 p.amount,
                 p.currency,
                 p.method,
                 p.provider,
                 p.phone_number,
                 p.status,
                 p.transaction_ref,
                 p.transaction_id,
                 p.paid_at,
                 p.created_at,
                 sp.label       AS plan_name,
                 sp.code        AS plan_description,
                 v.immatriculation                                              AS vehicle_plate,
                 COALESCE(NULLIF(v.nickname, ''), CONCAT(v.marque, ' ', v.model)) AS vehicle_name
             FROM payments p
                      LEFT JOIN subscription_plans sp ON sp.id = p.plan_id
                      LEFT JOIN voitures v            ON v.id  = p.vehicle_id
             WHERE p.user_id = :user_id
             ORDER BY p.created_at DESC`,
            {
                replacements: { user_id },
                type: sequelize.QueryTypes.SELECT,
            }
        );

        const data = rows.map(p => ({
            id:              p.id,
            vehicle_id:      p.vehicle_id,
            vehicle_name:    p.vehicle_name  ?? 'Unknown Vehicle',
            vehicle_plate:   p.vehicle_plate ?? '',
            amount:          p.amount,
            currency:        p.currency      ?? 'XAF',
            method:          p.method,
            provider:        p.provider,
            phone_number:    p.phone_number,
            status:          p.status,
            transaction_ref: p.transaction_ref,
            paid_at:         p.paid_at,
            created_at:      p.created_at,
            plan:            p.plan_name ? { name: p.plan_name, description: p.plan_description } : null,
        }));

        return res.status(200).json({ success: true, data });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] getPaymentHistory error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while fetching payment history',
        });
    }
};

/**
 * GET /api/payments/vehicle/:vehicle_id
 * Get active subscription for a specific vehicle
 */
const getVehicleSubscription = async (req, res) => {
    try {
        const { vehicle_id } = req.params;
        const user_id = req.user.id;

        const subscription = await Subscription.findOne({
            where: { vehicle_id, user_id, status: 'ACTIVE' },
            include: [{ model: SubscriptionPlan, as: 'plan' }]
        });

        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: 'No active subscription found for this vehicle'
            });
        }

        return res.status(200).json({
            success: true,
            data: subscription
        });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] getVehicleSubscription error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while fetching vehicle subscription'
        });
    }
};

/**
 * GET /api/payments/subscriptions/all
 * Returns every vehicle the user owns together with its active subscription
 * (if any). One query — no N+1.
 *
 * Response shape:
 * {
 *   success: true,
 *   data: [
 *     {
 *       vehicle_id, vehicle_name, vehicle_plate,
 *       subscription: { id, status, start_date, end_date, plan: { name, features, ... } } | null
 *     }, ...
 *   ]
 * }
 */
const getAllVehicleSubscriptions = async (req, res) => {
    try {
        const user_id   = req.user.id;
        const sequelize = require('../config/database');

        const rows = await sequelize.query(
            `SELECT
                 v.id                                                                   AS vehicle_id,
                 COALESCE(NULLIF(v.nickname, ''), CONCAT(v.marque, ' ', v.model))      AS vehicle_name,
                 v.immatriculation                                                      AS vehicle_plate,
                 s.id                                                                   AS sub_id,
                 s.status                                                               AS sub_status,
                 s.start_date                                                           AS sub_start,
                 s.end_date                                                             AS sub_end,
                 sp.id                                                                  AS plan_id,
                 sp.label                                                               AS plan_name,
                 sp.code                                                                AS plan_code,
                 sp.price                                                               AS plan_price,
                 sp.currency                                                            AS plan_currency,
                 sp.billing_mode                                                        AS plan_billing_mode,
                 sp.duration_months                                                     AS plan_duration_months,
                 sp.features                                                            AS plan_features
             FROM association_user_voitures auv
                      JOIN voitures v ON v.id = auv.voiture_id
                      LEFT JOIN subscriptions s
                                ON  s.vehicle_id = v.id
                                    AND s.user_id    = auv.user_id
                                    AND s.status     = 'ACTIVE'
                                    AND s.end_date   > NOW()
                      LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
             WHERE auv.user_id = :user_id
             ORDER BY v.id ASC`,
            {
                replacements: { user_id },
                type: sequelize.QueryTypes.SELECT,
            }
        );

        const data = rows.map(r => ({
            vehicle_id:    r.vehicle_id,
            vehicle_name:  r.vehicle_name  ?? 'Unknown Vehicle',
            vehicle_plate: r.vehicle_plate ?? '',
            subscription:  r.sub_id ? {
                id:         r.sub_id,
                status:     r.sub_status,
                start_date: r.sub_start,
                end_date:   r.sub_end,
                plan: {
                    id:              r.plan_id,
                    name:            r.plan_name,
                    code:            r.plan_code,
                    price:           r.plan_price,
                    currency:        r.plan_currency,
                    billing_mode:    r.plan_billing_mode,
                    duration_months: r.plan_duration_months,
                    features:        r.plan_features,
                },
            } : null,
        }));

        return res.status(200).json({ success: true, data });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] getAllVehicleSubscriptions error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while fetching vehicle subscriptions',
        });
    }
};

/**
 * GET /api/payments/plans
 * Get all active subscription plans
 */
const getSubscriptionPlans = async (req, res) => {
    try {
        const plans = await SubscriptionPlan.findAll({
            where: { is_active: true },
            order: [['price', 'ASC']]
        });

        return res.status(200).json({
            success: true,
            data: plans
        });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] getSubscriptionPlans error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while fetching subscription plans'
        });
    }
};

module.exports = {
    initiatePayment,
    getPaymentHistory,
    getVehicleSubscription,
    getAllVehicleSubscriptions,
    getSubscriptionPlans,
    initiatePaymentBatch,
};