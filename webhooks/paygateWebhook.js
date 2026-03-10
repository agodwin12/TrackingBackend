// webhooks/paygateWebhook.js
const crypto           = require('crypto');
const Payment          = require('../models/payment');
const Subscription     = require('../models/subscription');
const SubscriptionPlan = require('../models/subscriptionPlan');

// ─────────────────────────────────────────────────────────────────────────────
// RENEWAL HELPER
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Adds duration to a base date using the plan's billing_mode.
 * MONTH: calendar month (March 15 → April 15).
 * DAY:   plain day count (used for YEARLY = 365 days).
 */
const _addDuration = (baseDate, plan) => {
    const result = new Date(baseDate);
    if (plan.billing_mode === 'MONTH' && plan.duration_months) {
        result.setMonth(result.getMonth() + plan.duration_months);
    } else {
        result.setDate(result.getDate() + (plan.duration_days || 30));
    }
    return result;
};

const _calculateEndDate = (existingSub, plan) => {
    const now = new Date();

    if (existingSub && existingSub.end_date) {
        const currentEnd = new Date(existingSub.end_date);
        const base = currentEnd > now ? currentEnd : now;
        return _addDuration(base, plan);
    }

    return _addDuration(now, plan);
};

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK HANDLER
// ─────────────────────────────────────────────────────────────────────────────
const handlePaygateWebhook = async (req, res) => {
    console.log('📩 [WEBHOOK] PayGate webhook received');
    console.log('📋 [WEBHOOK] Headers:', req.headers);

    // ── 1. Signature verification ─────────────────────────────────────────────
    const receivedSig = req.headers['x-signature'];
    const secret      = process.env.PAYGATE_WEBHOOK_SECRET;

    if (!receivedSig || !secret) {
        console.warn('⚠️  [WEBHOOK] Missing signature or secret — rejecting');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : JSON.stringify(req.body);

    console.log('─'.repeat(45));
    console.log('🔐 [WEBHOOK SIG] Secret    :', secret);
    console.log('🔐 [WEBHOOK SIG] Raw body  :', rawBody);

    const computedSig = crypto
        .createHmac('sha1', secret)
        .update(rawBody)
        .digest('hex');

    console.log('🔐 [WEBHOOK SIG] Computed  :', computedSig);
    console.log('🔐 [WEBHOOK SIG] Received  :', receivedSig);

    const sigMatch =
        computedSig.length === receivedSig.length &&
        crypto.timingSafeEqual(
            Buffer.from(computedSig),
            Buffer.from(receivedSig),
        );

    console.log('🔐 [WEBHOOK SIG] Match?    :', sigMatch);
    console.log('─'.repeat(45));

    if (!sigMatch) {
        console.warn('⚠️  [WEBHOOK] Invalid signature — rejecting');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── 2. Parse body ─────────────────────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (e) {
        console.error('❌ [WEBHOOK] Failed to parse JSON:', e.message);
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { status, transaction_id, errorCode } = payload;

    // ── DETAILED PAYLOAD LOG — helps diagnose batch lookup issues ─────────────
    console.log('📦 [WEBHOOK] Full payload:', JSON.stringify(payload, null, 2));
    console.log('📦 [WEBHOOK] status            :', status);
    console.log('📦 [WEBHOOK] transaction_id     :', transaction_id);
    console.log('📦 [WEBHOOK] external_reference :', external_reference);
    console.log('📦 [WEBHOOK] errorCode          :', errorCode);
    console.log('📦 [WEBHOOK] All payload keys   :', Object.keys(payload));



    // ── 3. Find matching payment records ──────────────────────────────────────
    // Both single and batch payments are now stored with the same transaction_id
    // (unique constraint on transaction_id was removed from the payments table).
    // So one simple lookup by transaction_id covers all cases.

    if (!transaction_id) {
        console.warn('⚠️  [WEBHOOK] No transaction_id in payload — cannot process');
        return res.status(200).json({ received: true });
    }

    const payments = await Payment.findAll({
        where: { transaction_id },
        include: [{ model: SubscriptionPlan, as: 'plan' }],
    });

    console.log(`🔍 [WEBHOOK] Lookup by transaction_id=${transaction_id} → ${payments.length} row(s)`);
    if (payments.length > 0) {
        console.log(`🔍 [WEBHOOK] Rows:`, payments.map(p => ({
            id: p.id, ref: p.transaction_ref, status: p.status, vehicle_id: p.vehicle_id
        })));
    }

    if (!payments || payments.length === 0) {
        console.warn(`⚠️  [WEBHOOK] No payments found (tried: ${lookupMethod})`);
        // Return 200 so PayGate doesn't keep retrying
        return res.status(200).json({ received: true });
    }

    console.log(`✅ [WEBHOOK] Found ${payments.length} payment(s) via ${lookupMethod}`);

    // ── 4. Idempotency ────────────────────────────────────────────────────────
    const pendingPayments = payments.filter((p) => p.status === 'PENDING');
    if (pendingPayments.length === 0) {
        console.log('ℹ️  [WEBHOOK] All payments already processed — skipping');
        return res.status(200).json({ received: true });
    }

    // ── 5. Handle SUCCESS ─────────────────────────────────────────────────────
    if (status === 'SUCCESS' && (errorCode === 0 || errorCode === '0')) {
        console.log(`💰 [WEBHOOK] SUCCESS — processing ${pendingPayments.length} payment(s)...`);

        for (const payment of pendingPayments) {
            try {
                const plan = payment.plan;
                if (!plan) {
                    console.error(`❌ [WEBHOOK] No plan attached to payment ${payment.id}`);
                    continue;
                }

                const now = new Date();

                const existingSub = await Subscription.findOne({
                    where: {
                        vehicle_id: payment.vehicle_id,
                        user_id:    payment.user_id,
                        status:     'ACTIVE',
                    },
                    order: [['end_date', 'DESC']],
                });

                const endDate = _calculateEndDate(existingSub, plan);

                if (existingSub) {
                    console.log(
                        `🔄 [WEBHOOK] Renewing vehicle ${payment.vehicle_id} — ` +
                        `${existingSub.end_date} → ${endDate}`
                    );
                    await existingSub.update({ status: 'RENEWED' });
                } else {
                    console.log(
                        `🆕 [WEBHOOK] New sub for vehicle ${payment.vehicle_id} until ${endDate}`
                    );
                }

                const subscription = await Subscription.create({
                    user_id:    payment.user_id,
                    vehicle_id: payment.vehicle_id,
                    plan_id:    payment.plan_id,
                    status:     'ACTIVE',
                    start_date: now,
                    end_date:   endDate,
                });

                await payment.update({
                    status:          'SUCCESS',
                    subscription_id: subscription.id,
                    paid_at:         now,
                });

                console.log(
                    `✅ [WEBHOOK] Payment ${payment.id} → Sub ${subscription.id} ` +
                    `for vehicle ${payment.vehicle_id}`
                );
            } catch (err) {
                console.error(`❌ [WEBHOOK] Error on payment ${payment.id}:`, err.message);
                // Continue — don't let one vehicle failure block the rest
            }
        }

        return res.status(200).json({ received: true });
    }

    // ── 6. Handle FAILED ──────────────────────────────────────────────────────
    if (status === 'FAILED' || (errorCode && errorCode !== 0 && errorCode !== '0')) {
        console.log('❌ [WEBHOOK] FAILED — marking payments...');

        for (const payment of pendingPayments) {
            await payment.update({ status: 'FAILED' });
        }

        console.log(`🚫 [WEBHOOK] Marked ${pendingPayments.length} payment(s) as FAILED`);
        return res.status(200).json({ received: true });
    }

    // ── 7. Unknown status ─────────────────────────────────────────────────────
    console.warn(`⚠️  [WEBHOOK] Unknown status: "${status}" — ignoring`);
    return res.status(200).json({ received: true });
};

module.exports = { handlePaygateWebhook };