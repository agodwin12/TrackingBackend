// webhooks/paygateWebhook.js
const crypto           = require('crypto');
const Payment          = require('../models/payment');
const Subscription     = require('../models/subscription');
const SubscriptionPlan = require('../models/subscriptionPlan');
const socketService    = require('../services/socketService');
const notificationController         = require('../controllers/notificationController');
const { invalidateVehicleFeatureCache } = require('../services/hasFeature');

// ─────────────────────────────────────────────────────────────────────────────
// RENEWAL HELPER
// ─────────────────────────────────────────────────────────────────────────────
const _addDuration = (baseDate, plan) => {
    const result = new Date(baseDate);
    result.setMonth(result.getMonth() + (plan.duration_months || 1));
    return result;
};

const _calculateEndDate = (existingSub, plan) => {
    const now = new Date();
    if (existingSub?.end_date) {
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
    // ── FULL DIAGNOSTIC LOG ───────────────────────────────────────────────────
    console.log('\n📩 [WEBHOOK] ══════════════════════════════════');
    console.log('📩 [WEBHOOK] Received at:', new Date().toISOString());
    console.log('📋 [WEBHOOK] All headers:', JSON.stringify(req.headers, null, 2));
    console.log('📋 [WEBHOOK] Body type  :', typeof req.body, '| isBuffer:', Buffer.isBuffer(req.body));

    const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body);

    console.log('📋 [WEBHOOK] Raw body   :', rawBody);

    // ── 1. Signature verification ─────────────────────────────────────────────
    // HTTP headers are normalised to lowercase by Express/Node
    const receivedSig = req.headers['x-signature'];
    const secret      = process.env.PAYGATE_WEBHOOK_SECRET;

    console.log('🔐 [WEBHOOK] x-signature header:', receivedSig ?? '(missing)');
    console.log('🔐 [WEBHOOK] Secret configured :', secret ? 'yes' : 'NO — check .env');

    if (!secret) {
        console.error('❌ [WEBHOOK] PAYGATE_WEBHOOK_SECRET not set in .env');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    if (!receivedSig) {
        // PayGate did not send a signature — skip verification and log a warning
        // Remove this branch once you confirm PayGate sends X-Signature
        console.warn('⚠️  [WEBHOOK] No x-signature header — SKIPPING signature check (debug mode)');
        // return res.status(401).json({ error: 'Missing signature' });
    } else {
        const computedSig = crypto
            .createHmac('sha1', secret)
            .update(rawBody)
            .digest('hex');

        console.log('🔐 [WEBHOOK] Computed sig:', computedSig);
        console.log('🔐 [WEBHOOK] Received sig:', receivedSig);

        let sigMatch = false;
        try {
            sigMatch = computedSig.length === receivedSig.length &&
                crypto.timingSafeEqual(
                    Buffer.from(computedSig),
                    Buffer.from(receivedSig),
                );
        } catch (_) {
            sigMatch = false;
        }

        console.log('🔐 [WEBHOOK] Sig match   :', sigMatch);

        if (!sigMatch) {
            console.warn('⚠️  [WEBHOOK] Invalid signature — rejecting');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    // ── 2. Parse body ─────────────────────────────────────────────────────────
    let payload;
    try {
        payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch (e) {
        console.error('❌ [WEBHOOK] Failed to parse JSON:', e.message);
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    console.log('📦 [WEBHOOK] Parsed payload:', JSON.stringify(payload, null, 2));

    const { status, transaction_id, errorCode } = payload;

    if (!transaction_id) {
        console.warn('⚠️  [WEBHOOK] No transaction_id in payload — cannot process');
        return res.status(200).json({ received: true });
    }

    // ── 3. Find matching payment records ──────────────────────────────────────
    const payments = await Payment.findAll({
        where:   { transaction_id },
        include: [{ model: SubscriptionPlan, as: 'plan' }],
    });

    console.log(`🔍 [WEBHOOK] Found ${payments.length} row(s) for transaction_id=${transaction_id}`);

    if (!payments || payments.length === 0) {
        console.warn(`⚠️  [WEBHOOK] No payments found for transaction_id=${transaction_id}`);
        return res.status(200).json({ received: true });
    }

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
                    await existingSub.update({ status: 'RENEWED' });
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

                await invalidateVehicleFeatureCache(payment.vehicle_id);

                console.log(`✅ [WEBHOOK] Payment ${payment.id} → Sub ${subscription.id} for vehicle ${payment.vehicle_id}`);

                socketService.emitPaymentUpdate(
                    payment.user_id, 'SUCCESS', payment.id, payment.vehicle_id,
                );

                notificationController.sendToUser(payment.user_id, {
                    title: '✅ Payment Successful',
                    body:  `Your subscription for plan "${plan.label}" is now active.`,
                    data: {
                        type:       'payment_success',
                        payment_id: String(payment.id),
                        vehicle_id: String(payment.vehicle_id),
                        plan_label: plan.label,
                    },
                }).catch(err =>
                    console.error(`⚠️  [WEBHOOK] Push failed for payment ${payment.id}:`, err.message)
                );

            } catch (err) {
                console.error(`❌ [WEBHOOK] Error on payment ${payment.id}:`, err.message);
            }
        }

        return res.status(200).json({ received: true });
    }

    // ── 6. Handle FAILED ──────────────────────────────────────────────────────
    if (status === 'FAILED' || (errorCode && errorCode !== 0 && errorCode !== '0')) {
        console.log('❌ [WEBHOOK] FAILED — marking payments...');

        for (const payment of pendingPayments) {
            await payment.update({ status: 'FAILED' });

            socketService.emitPaymentUpdate(
                payment.user_id, 'FAILED', payment.id, payment.vehicle_id,
            );

            notificationController.sendToUser(payment.user_id, {
                title: '❌ Payment Failed',
                body:  'Your payment could not be processed. Please try again.',
                data: {
                    type:       'payment_failed',
                    payment_id: String(payment.id),
                    vehicle_id: String(payment.vehicle_id),
                },
            }).catch(err =>
                console.error(`⚠️  [WEBHOOK] Push failed for payment ${payment.id}:`, err.message)
            );
        }

        return res.status(200).json({ received: true });
    }

    // ── 7. Unknown status ─────────────────────────────────────────────────────
    console.warn(`⚠️  [WEBHOOK] Unknown status: "${status}" — ignoring`);
    return res.status(200).json({ received: true });
};

module.exports = { handlePaygateWebhook };