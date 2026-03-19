// services/subscriptionExpiryService.js
const { Op }             = require('sequelize');
const Subscription       = require('../models/subscription');
const SubscriptionPlan   = require('../models/subscriptionPlan');
const Voiture            = require('../models/voiture');
const User               = require('../models/userModel');
const notificationCtrl   = require('../controllers/notificationController');
const { sendExpiryReminderEmail } = require('./emailService');
const logger             = require('../utils/logger');

const REMINDER_DAYS = [3, 2, 1];

/**
 * Called once daily by the cron, or manually via the dev route.
 *
 * Options:
 *   dryRun {boolean} — when true, queries and logs normally but skips
 *                      actual email and push delivery. Returns the same
 *                      summary structure with actions marked as skipped.
 */
const sendExpiryReminders = async ({ dryRun = false } = {}) => {
    logger.info(`[EXPIRY] Starting reminder run${dryRun ? ' (DRY RUN)' : ''}...`);

    const summary = {
        dryRun,
        totalEmailsSent: 0,
        totalPushSent:   0,
        totalErrors:     0,
        byDay:           {},
    };

    for (const daysLeft of REMINDER_DAYS) {
        try {
            const dayResult = await _processDay(daysLeft, { dryRun });
            summary.byDay[`in_${daysLeft}_day`] = dayResult;
            summary.totalEmailsSent += dayResult.emailsSent;
            summary.totalPushSent   += dayResult.pushSent;
            summary.totalErrors     += dayResult.errors;
        } catch (err) {
            logger.error(`[EXPIRY] Unhandled error for daysLeft=${daysLeft}: ${err.message}`);
            summary.totalErrors++;
            summary.byDay[`in_${daysLeft}_day`] = { error: err.message };
        }
    }

    logger.info(
        `[EXPIRY] Run complete — emails: ${summary.totalEmailsSent}, ` +
        `pushes: ${summary.totalPushSent}, errors: ${summary.totalErrors}`
    );

    return summary;
};

// ─────────────────────────────────────────────────────────────────────────────

const _processDay = async (daysLeft, { dryRun }) => {
    const now    = new Date();
    const target = new Date(now);
    target.setDate(target.getDate() + daysLeft);

    const dayStart = new Date(target);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(target);
    dayEnd.setHours(23, 59, 59, 999);

    logger.info(
        `[EXPIRY] daysLeft=${daysLeft} | window: ${dayStart.toISOString()} → ${dayEnd.toISOString()}`
    );

    const subscriptions = await Subscription.findAll({
        where: {
            status:   'ACTIVE',
            end_date: { [Op.between]: [dayStart, dayEnd] },
        },
        include: [
            { model: SubscriptionPlan, as: 'plan',    attributes: ['label'] },
            { model: Voiture,          as: 'vehicle',  attributes: ['id', 'immatriculation'] },
        ],
    });

    const result = {
        subscriptionsFound: subscriptions.length,
        usersNotified:      0,
        emailsSent:         0,
        pushSent:           0,
        errors:             0,
        users:              [],   // per-user detail for Postman inspection
    };

    if (subscriptions.length === 0) {
        logger.info(`[EXPIRY] No subscriptions expiring in ${daysLeft} day(s)`);
        return result;
    }

    logger.info(`[EXPIRY] Found ${subscriptions.length} subscription(s) expiring in ${daysLeft} day(s)`);

    // Group by user_id
    const byUser = new Map();
    for (const sub of subscriptions) {
        if (!byUser.has(sub.user_id)) byUser.set(sub.user_id, []);
        byUser.get(sub.user_id).push(sub);
    }

    for (const [userId, subs] of byUser.entries()) {
        try {
            const userResult = await _notifyUser(userId, subs, daysLeft, { dryRun });
            result.usersNotified++;
            result.emailsSent += userResult.emailSent ? 1 : 0;
            result.pushSent   += userResult.pushSent  ? 1 : 0;
            result.errors     += userResult.error     ? 1 : 0;
            result.users.push(userResult);
        } catch (err) {
            logger.error(`[EXPIRY] Error notifying user ${userId}: ${err.message}`);
            result.errors++;
            result.users.push({ userId, error: err.message });
        }
    }

    return result;
};

const _notifyUser = async (userId, subs, daysLeft, { dryRun }) => {
    const user = await User.findOne({
        where:      { id: userId },
        attributes: ['id', 'email', 'nom', 'prenom'],
    });

    if (!user) {
        logger.warn(`[EXPIRY] User ${userId} not found — skipping`);
        return { userId, skipped: 'user not found' };
    }

    const vehicles = subs.map(s => ({
        immatriculation: s.vehicle?.immatriculation || `Vehicle #${s.vehicle_id}`,
        end_date:        s.end_date,
        plan_label:      s.plan?.label || 'Subscription',
    }));

    const plates     = vehicles.map(v => v.immatriculation);
    const vehicleIds = subs.map(s => String(s.vehicle_id)).join(',');

    const entry = {
        userId,
        email:     user.email || null,
        plates,
        daysLeft,
        emailSent: false,
        pushSent:  false,
        dryRun,
        error:     null,
    };

    if (dryRun) {
        logger.info(
            `[EXPIRY][DRY RUN] Would notify user ${userId} (${user.email}) — plates: ${plates.join(', ')}`
        );
        return entry;
    }

    // ── Email ────────────────────────────────────────────────────────────────
    if (user.email) {
        const emailResult = await sendExpiryReminderEmail(user.email, vehicles, daysLeft);
        if (emailResult.success) {
            entry.emailSent = true;
        } else {
            logger.warn(`[EXPIRY] Email failed for user ${userId}: ${emailResult.error}`);
            entry.error = emailResult.error;
        }
    } else {
        logger.warn(`[EXPIRY] User ${userId} has no email — skipping email`);
    }

    // ── Push ─────────────────────────────────────────────────────────────────
    try {
        await notificationCtrl.sendSubscriptionExpiryNotification(
            userId,
            daysLeft,
            plates,
            vehicleIds,
        );
        entry.pushSent = true;
    } catch (err) {
        logger.error(`[EXPIRY] Push failed for user ${userId}: ${err.message}`);
        entry.error = entry.error
            ? `${entry.error}; push: ${err.message}`
            : `push: ${err.message}`;
    }

    return entry;
};

module.exports = { sendExpiryReminders };