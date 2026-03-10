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
 * Get full payment history for the logged in user
 */
const getPaymentHistory = async (req, res) => {
    try {
        const user_id = req.user.id;

        const payments = await Payment.findAll({
            where: { user_id },
            include: [
                { model: SubscriptionPlan, as: 'plan' },
                { model: Subscription,     as: 'subscription' }
            ],
            order: [['created_at', 'DESC']]
        });

        return res.status(200).json({
            success: true,
            data: payments
        });

    } catch (error) {
        console.error('❌ [PAYMENT CONTROLLER] getPaymentHistory error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while fetching payment history'
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
    getSubscriptionPlans,
    initiatePaymentBatch
};