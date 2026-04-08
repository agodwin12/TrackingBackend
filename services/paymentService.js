// services/paymentService.js
const { Op }           = require('sequelize');
const sequelize        = require('../config/database');
const Payment          = require('../models/payment');
const Subscription     = require('../models/subscription');
const SubscriptionPlan = require('../models/subscriptionPlan');
const Vehicle          = require('../models/voiture');
const { initiatePayment: paygateInitiate } = require('./paygateService');
const { v4: uuidv4 }   = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────
// JUNCTION TABLE CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const JUNCTION_TABLE      = 'association_user_voitures';
const JUNCTION_VEHICLE_FK = 'voiture_id';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIX: The old _ownedByUser helper produced:
 *   WHERE id IN (...vehicle_ids...) AND id IN (SELECT voiture_id ...)
 *
 * When Sequelize merges two `id` conditions from separate where objects,
 * the second [Op.in] can silently override the first array IN, causing
 * Vehicle.findAll to return 0 rows even when the user owns all vehicles.
 *
 * The correct approach is a single WHERE clause that does BOTH checks
 * in one [Op.in] using a raw subquery that filters by BOTH vehicle_ids
 * AND user ownership at once.
 */
const _ownedByUserAndInList = (userId, vehicleIds) => ({
    id: {
        [Op.in]: sequelize.literal(
            `(SELECT ${JUNCTION_VEHICLE_FK} FROM ${JUNCTION_TABLE} ` +
            `WHERE user_id = ${sequelize.escape(userId)} ` +
            `AND ${JUNCTION_VEHICLE_FK} IN (${vehicleIds.map(id => sequelize.escape(id)).join(',')}))`
        ),
    },
});

/**
 * Single-vehicle ownership check (unchanged logic, kept separate for clarity).
 */
const _ownedByUser = (userId) => ({
    id: {
        [Op.in]: sequelize.literal(
            `(SELECT ${JUNCTION_VEHICLE_FK} FROM ${JUNCTION_TABLE} WHERE user_id = ${sequelize.escape(userId)})`
        ),
    },
});

/**
 * Adds duration to a base date according to the plan's billing_mode.
 *
 * MONTH mode: addMonths(n) — March 15 + 1 month = April 15.
 *   JavaScript's setMonth() auto-clamps: Jan 31 + 1 month = Feb 28/29. ✅
 *
 * DAY mode: addDays(n) — plain day count (used for YEARLY = 365 days).
 */
const _addDuration = (baseDate, plan) => {
    const result = new Date(baseDate);

    if (plan.billing_mode === 'MONTH' && plan.duration_months) {
        result.setMonth(result.getMonth() + plan.duration_months);
    } else {
        // DAY mode (or fallback if duration_months missing)
        const days = plan.duration_days || 30;
        result.setDate(result.getDate() + days);
    }

    return result;
};

/**
 * Calculates start_date and end_date for a new subscription.
 *
 * Renewal (carry-over) logic:
 *   - Active sub not yet expired → new duration stacks on top of end_date.
 *   - Expired or no sub → starts fresh from today.
 */
const _calculateDates = (existingSub, plan) => {
    const now = new Date();

    if (existingSub && existingSub.end_date) {
        const currentEnd = new Date(existingSub.end_date);
        const base       = currentEnd > now ? currentEnd : now;
        const endDate    = _addDuration(base, plan);
        return { startDate: now, endDate };
    }

    const endDate = _addDuration(now, plan);
    return { startDate: now, endDate };
};

/**
 * Validates plan is active + single vehicle belongs to user.
 */
const _validatePlanAndVehicle = async (planId, vehicleId, userId) => {
    const plan = await SubscriptionPlan.findOne({
        where: { id: planId, is_active: true },
    });
    if (!plan) throw new Error('Subscription plan not found or inactive.');

    const vehicle = await Vehicle.findOne({
        where: {
            id: vehicleId,
            ..._ownedByUser(userId),
        },
    });
    if (!vehicle) {
        throw new Error(`Vehicle ${vehicleId} not found or does not belong to you.`);
    }

    return { plan, vehicle };
};

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE VEHICLE PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
const initiateSubscriptionPayment = async ({
                                               user_id,
                                               vehicle_id,
                                               plan_id,
                                               method,
                                               provider,
                                               phone_number,
                                               country_code,
                                           }) => {
    const { plan } = await _validatePlanAndVehicle(plan_id, vehicle_id, user_id);

    const existingSub = await Subscription.findOne({
        where:  { vehicle_id, user_id, status: 'ACTIVE' },
        order:  [['end_date', 'DESC']],
    });

    const totalAmount = parseFloat(plan.price);

    // ── MOBILE MONEY ──────────────────────────────────────────────────────────
    if (method === 'MOBILE_MONEY') {
        const customRef = `WGO-${uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase()}`;

        const payment = await Payment.create({
            user_id,
            vehicle_id,
            plan_id,
            amount:          totalAmount,
            currency:        plan.currency || 'XAF',
            method,
            provider:        provider     || null,
            phone_number:    phone_number || null,
            status:          'PENDING',
            transaction_ref: customRef,
        });

        let paygateResponse;
        try {
            paygateResponse = await paygateInitiate(
                totalAmount,
                phone_number,
                provider,
                customRef,
                country_code,
            );
        } catch (err) {
            await payment.update({ status: 'FAILED' });
            throw new Error(`PayGate error: ${err.message}`);
        }

        await payment.update({
            transaction_ref: paygateResponse.generated_ref || customRef,
            transaction_id:  paygateResponse.transaction_id || null,
        });

        return {
            payment_id:     payment.id,
            transaction_id: paygateResponse.transaction_id,
            redirect_url:   paygateResponse.redirect_url,
            reference:      paygateResponse.generated_ref || customRef,
            expires_at:     paygateResponse.expires_at    || null,
            amount:         totalAmount,
            currency:       plan.currency || 'XAF',
            vehicle_count:  1,
            renewal_info:   existingSub
                ? `Active sub found — days will be added on top of ${existingSub.end_date}`
                : 'New subscription will be created after payment confirmation',
        };
    }

    // ── CASH ──────────────────────────────────────────────────────────────────
    if (method === 'CASH') {
        const { startDate, endDate } = _calculateDates(existingSub, plan);

        if (existingSub) await existingSub.update({ status: 'RENEWED' });

        // Create payment first so we have its id to link into the subscription
        const payment = await Payment.create({
            user_id,
            vehicle_id,
            plan_id,
            amount:          totalAmount,
            currency:        plan.currency || 'XAF',
            method,
            status:          'SUCCESS',
            paid_at:         new Date(),
            transaction_ref: `CASH-${uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase()}`,
        });

        // Create subscription with payment_id linked  ✅ FIX
        const subscription = await Subscription.create({
            user_id,
            vehicle_id,
            plan_id,
            status:     'ACTIVE',
            start_date: startDate,
            end_date:   endDate,
            payment_id: payment.id,   // ✅ FIX: link payment → subscription
        });

        // Back-link subscription → payment
        await payment.update({ subscription_id: subscription.id });

        return {
            payment_id:      payment.id,
            subscription_id: subscription.id,
            amount:          totalAmount,
            currency:        plan.currency || 'XAF',
            vehicle_count:   1,
            start_date:      startDate,
            end_date:        endDate,
            renewed:         !!existingSub,
            renewal_info:    existingSub
                ? `Extended — was expiring ${existingSub.end_date}, now expires ${endDate}`
                : `New subscription active until ${endDate}`,
        };
    }

    throw new Error('Invalid payment method.');
};

// ─────────────────────────────────────────────────────────────────────────────
// BATCH VEHICLE PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
const initiateSubscriptionPaymentBatch = async ({
                                                    user_id,
                                                    vehicle_ids,
                                                    plan_id,
                                                    method,
                                                    provider,
                                                    phone_number,
                                                    country_code,
                                                }) => {
    // Validate plan
    const plan = await SubscriptionPlan.findOne({
        where: { id: plan_id, is_active: true },
    });
    if (!plan) throw new Error('Subscription plan not found or inactive.');

    // FIX: use combined subquery so Sequelize doesn't merge/clobber two
    // separate `id` conditions.
    const normalizedIds = vehicle_ids.map(Number);

    const vehicles = await Vehicle.findAll({
        where: _ownedByUserAndInList(user_id, normalizedIds),
    });

    console.log(`🔍 [BATCH] Requested IDs: [${normalizedIds}] | Found: [${vehicles.map(v => v.id)}] | user_id: ${user_id}`);

    if (vehicles.length !== normalizedIds.length) {
        const foundIds   = vehicles.map((v) => Number(v.id));
        const missingIds = normalizedIds.filter((id) => !foundIds.includes(id));
        throw new Error(`Vehicles not found or unauthorized: ${missingIds.join(', ')}`);
    }

    const unitPrice   = parseFloat(plan.price);
    const totalAmount = unitPrice * normalizedIds.length;

    // ── MOBILE MONEY ──────────────────────────────────────────────────────────
    if (method === 'MOBILE_MONEY') {
        const batchRef = `WGO-B-${uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase()}`;

        const payments = await Promise.all(
            normalizedIds.map((vid) =>
                Payment.create({
                    user_id,
                    vehicle_id:      vid,
                    plan_id,
                    amount:          unitPrice,
                    currency:        plan.currency || 'XAF',
                    method,
                    provider:        provider     || null,
                    phone_number:    phone_number || null,
                    status:          'PENDING',
                    transaction_ref: `${batchRef}-V${vid}`,
                })
            ),
        );

        let paygateResponse;
        try {
            paygateResponse = await paygateInitiate(
                totalAmount,
                phone_number,
                provider,
                batchRef,
                country_code,
            );
        } catch (err) {
            await Payment.update(
                { status: 'FAILED' },
                { where: { transaction_ref: payments.map((p) => p.transaction_ref) } },
            );
            throw new Error(`PayGate error: ${err.message}`);
        }

        // Stamp the same PayGate transaction_id on all batch payment rows.
        // The webhook uses transaction_id to find all rows for this batch.
        const pgTransactionId = paygateResponse.transaction_id || null;
        await Promise.all(
            payments.map((p) => p.update({ transaction_id: pgTransactionId }))
        );
        console.log(`✅ [BATCH] Stamped transaction_id=${pgTransactionId} on ${payments.length} rows`);

        const paymentIds = payments.map((p) => p.id);
        console.log(`✅ [BATCH] All payments ready. IDs: ${paymentIds} | batchRef: ${batchRef}`);

        return {
            payment_ids:    paymentIds,
            transaction_id: pgTransactionId,
            redirect_url:   paygateResponse.redirect_url,
            reference:      paygateResponse.generated_ref || batchRef,
            batch_ref:      batchRef,
            expires_at:     paygateResponse.expires_at    || null,
            amount:         totalAmount,
            currency:       plan.currency || 'XAF',
            vehicle_count:  normalizedIds.length,
        };
    }

    // ── CASH ──────────────────────────────────────────────────────────────────
    if (method === 'CASH') {
        const results = [];

        for (const vehicleId of normalizedIds) {
            const existingSub = await Subscription.findOne({
                where: { vehicle_id: vehicleId, user_id, status: 'ACTIVE' },
                order: [['end_date', 'DESC']],
            });

            const { startDate, endDate } = _calculateDates(existingSub, plan);

            if (existingSub) await existingSub.update({ status: 'RENEWED' });

            // Create payment first so we have its id  ✅ FIX
            const payment = await Payment.create({
                user_id,
                vehicle_id:      vehicleId,
                plan_id,
                amount:          unitPrice,
                currency:        plan.currency || 'XAF',
                method,
                status:          'SUCCESS',
                paid_at:         new Date(),
                transaction_ref: `CASH-${uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase()}`,
            });

            // Create subscription with payment_id linked  ✅ FIX
            const subscription = await Subscription.create({
                user_id,
                vehicle_id: vehicleId,
                plan_id,
                status:     'ACTIVE',
                start_date: startDate,
                end_date:   endDate,
                payment_id: payment.id,   // ✅ FIX: link payment → subscription
            });

            // Back-link subscription → payment
            await payment.update({ subscription_id: subscription.id });

            results.push({
                vehicle_id:      vehicleId,
                payment_id:      payment.id,
                subscription_id: subscription.id,
                start_date:      startDate,
                end_date:        endDate,
                renewed:         !!existingSub,
                renewal_info:    existingSub
                    ? `Extended from ${existingSub.end_date} → ${endDate}`
                    : `New subscription until ${endDate}`,
            });
        }

        return {
            vehicle_count: normalizedIds.length,
            amount:        totalAmount,
            currency:      plan.currency || 'XAF',
            vehicles:      results,
        };
    }

    throw new Error('Invalid payment method.');
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    initiateSubscriptionPayment,
    initiateSubscriptionPaymentBatch,
};