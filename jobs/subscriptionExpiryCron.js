// jobs/subscriptionExpiryCron.js
const cron    = require('node-cron');
const logger  = require('../utils/logger');
const { sendExpiryReminders } = require('../services/subscriptionExpiryService');

class SubscriptionExpiryCron {


    static start() {
        logger.info('[EXPIRY CRON] Scheduling daily subscription expiry reminders at 08:00...');

        this._task = cron.schedule('0 8 * * *', async () => {
            logger.info('[EXPIRY CRON] Triggered — running expiry reminder checks...');
            try {
                const result = await sendExpiryReminders();
                logger.info(
                    `[EXPIRY CRON] Done — emails: ${result.totalEmailsSent}, ` +
                    `pushes: ${result.totalPushSent}, errors: ${result.totalErrors}`
                );
            } catch (err) {
                logger.error('[EXPIRY CRON] Unhandled error:', err.message);
            }
        });

        logger.info('[EXPIRY CRON] Scheduled ✅');
    }

    static stop() {
        if (this._task) {
            this._task.destroy();
            logger.info('[EXPIRY CRON] Stopped');
        }
    }

    /** Manual trigger — useful for testing without waiting for 08:00 */
    static async runManually() {
        logger.info('[EXPIRY CRON] Manual run triggered...');
        const result = await sendExpiryReminders();
        logger.info('[EXPIRY CRON] Manual run complete:', result);
        return result;
    }
}

module.exports = SubscriptionExpiryCron;