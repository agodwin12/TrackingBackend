// routes/devRoutes.js
// ⚠️  DEV ONLY — never registered in production (guarded in app.js)
// Allows manual triggering of the subscription expiry reminder job from Postman.

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const subscriptionExpiryService = require('../services/subscriptionExpiryService');

/**
 * POST /api/dev/test-expiry-reminder
 *
 * Runs sendExpiryReminders() immediately and returns a summary of what was sent.
 *
 * Optional body:
 *   { "dryRun": true }  — queries and logs but skips actual email/push delivery.
 *                         Useful for checking which users/vehicles would be matched
 *                         without spamming real devices during testing.
 */
router.post('/test-expiry-reminder', async (req, res) => {
    logger.info('🧪 Dev: manual expiry reminder trigger');

    try {
        const result = await subscriptionExpiryService.sendExpiryReminders({
            dryRun: req.body?.dryRun === true,
        });

        return res.json({
            success: true,
            message: 'Expiry reminder job completed',
            result,
        });
    } catch (err) {
        logger.error(`🧪 Dev: expiry reminder failed — ${err.message}`);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

module.exports = router;