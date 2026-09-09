// controllers/mobileMoneyClaimController.js
const MobileMoneyClaim = require('../models/mobileMoneyClaim');
const logger = require('../utils/logger');

// The Flutter side captures amounts straight out of regex groups, which can
// carry thousands-separator commas (e.g. "2,100") — strip those before they
// reach a DECIMAL column, or the insert fails outright.
const toDecimalOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const cleaned = String(value).replace(/,/g, '');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
};

// POST /api/recouvrement/mobile-money-claims
// Records a staff member's capture of a mobile money confirmation SMS from
// the "recouvrement semi-auto" flow. userId always comes from the verified
// JWT, never the request body — the same IDOR guard used by the PIN routes.
exports.create = async (req, res) => {
    try {
        const userId = req.user.id;
        const body = req.body || {};

        const network = (body.network || '').toString().trim().toLowerCase();
        const reference = (body.reference || '').toString().trim();
        const rawSmsText = (body.rawText || '').toString();

        if (!network || !['mtn', 'orange'].includes(network)) {
            return res.status(400).json({ success: false, message: "network must be 'mtn' or 'orange'" });
        }
        if (!reference) {
            return res.status(400).json({
                success: false,
                message: 'No transaction reference was found in this message — it cannot be recorded as a claim.',
                code: 'MISSING_REFERENCE',
            });
        }
        if (!rawSmsText) {
            return res.status(400).json({ success: false, message: 'rawText is required' });
        }

        // Idempotency: the same confirmation SMS submitted twice (retry, user
        // backs out and resubmits, etc.) returns the existing claim instead
        // of erroring or creating a duplicate.
        const existing = await MobileMoneyClaim.findOne({ where: { network, reference } });
        if (existing) {
            logger.info(`ℹ️ Mobile money claim already recorded: network=${network} reference=${reference} id=${existing.id}`);
            return res.status(200).json({
                success: true,
                alreadyExisted: true,
                claim: existing,
            });
        }

        const claim = await MobileMoneyClaim.create({
            submitted_by_user_id: userId,
            network,
            amount: toDecimalOrNull(body.amount),
            sender_name: body.senderName ?? null,
            sender_phone: body.senderPhone ?? null,
            recipient_name: body.recipientName ?? null,
            recipient_phone: body.recipientPhone ?? null,
            reference,
            transaction_timestamp: body.timestamp ? new Date(body.timestamp) : null,
            fee: toDecimalOrNull(body.fee),
            new_balance: toDecimalOrNull(body.newBalance),
            raw_sms_text: rawSmsText,
            captured_at_device: body.capturedAtDevice ? new Date(body.capturedAtDevice) : null,
        });

        logger.info(`✅ Mobile money claim recorded id=${claim.id} network=${network} reference=${reference} by user=${userId}`);

        return res.status(201).json({
            success: true,
            alreadyExisted: false,
            claim,
        });
    } catch (err) {
        logger.error('🔥 Error creating mobile money claim:', err.message);
        return res.status(500).json({ success: false, message: 'Error recording claim' });
    }
};
