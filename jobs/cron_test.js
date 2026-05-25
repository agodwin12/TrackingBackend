const cron = require('node-cron');
const logger = require('../utils/logger');
const { sendExpiryReminders } = require('../services/subscriptionExpiryService');

class SubscriptionExpiryCron {
    static start() {
        logger.info('[EXPIRY CRON] Scheduling daily subscription expiry reminders at 08:00...');

        this._task = cron.schedule('0 8 * * *', async () => {
            logger.info('[EXPIRY CRON] Triggered — running expiry reminder checks...');
            try {
                const result = await sendExpiryReminders();
                logger.info(
                    `[EXPIRY CRON] Done — pushes: ${result.totalPushSent}, errors: ${result.totalErrors}`
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

    static async runManually() {
        logger.info('[EXPIRY CRON] Manual run triggered...');
        const result = await sendExpiryReminders();
        logger.info(`[EXPIRY CRON] Manual run complete: ${JSON.stringify(result)}`);
        return result;
    }
}

module.exports = SubscriptionExpiryCron;

// Run immediately if this file is executed directly
if (require.main === module) {
    (async () => {
        try {
            await SubscriptionExpiryCron.runManually();
            process.exit(0);
        } catch (err) {
            logger.error('[EXPIRY CRON] Manual execution failed:', err.message);
            process.exit(1);
        }
    })();
}