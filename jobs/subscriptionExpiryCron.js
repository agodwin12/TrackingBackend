// services/subscriptionExpiryService.js
//
// Responsibilities (run once daily at 08:00):
//   1. Mark subscriptions as EXPIRED where status=ACTIVE and end_date < NOW
//   2. Send push notifications to users whose sub expires in exactly 7 days
//   3. Send push notifications to users whose sub expired today (just crossed midnight)
//
// Email is intentionally excluded — Brevo credentials are env-only and push
// notifications reach users faster on mobile. Add email here if needed later.

'use strict';

const { Op }              = require('sequelize');
const Subscription        = require('../models/subscription');
const SubscriptionPlan    = require('../models/subscriptionPlan');
const Voiture             = require('../models/voiture');
const User                = require('../models/userModel');
const notificationCtrl    = require('../controllers/notificationController');
const logger              = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Midnight of today (start of current day, local server time). */
const _todayStart = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

/** Midnight of tomorrow (end of today). */
const _todayEnd = () => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
};

/** Return a Date exactly `days` days from now at the same HH:mm:ss. */
const _daysFromNow = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
};

/** Format a Date as a readable string, e.g. "08 Apr 2026". */
const _fmtDate = (date) =>
    new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
    });

/** Best display name for a vehicle. */
const _vehicleName = (vehicle) =>
    (vehicle.nickname && vehicle.nickname.trim()) ||
    `${vehicle.marque || ''} ${vehicle.model || ''}`.trim() ||
    vehicle.immatriculation;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Expire overdue subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-update all ACTIVE subscriptions whose end_date is in the past.
 * Returns the number of rows updated.
 */
const _expireOverdueSubscriptions = async () => {
    const now = new Date();

    const [count] = await Subscription.update(
        { status: 'EXPIRED' },
        {
            where: {
                status:   'ACTIVE',
                end_date: { [Op.lt]: now },
            },
        },
    );

    if (count > 0) {
        logger.info(`[EXPIRY SERVICE] Marked ${count} subscription(s) as EXPIRED`);
    } else {
        logger.info('[EXPIRY SERVICE] No overdue subscriptions to expire');
    }

    return count;
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — 7-day advance warning push
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all ACTIVE subscriptions expiring in the next 7 days (±12 h window
 * around the 7-day mark so the daily cron always catches them once).
 * Sends one push per subscription.
 */
const _sendSevenDayWarnings = async () => {
    const windowStart = _daysFromNow(6);   // 6 days from now
    const windowEnd   = _daysFromNow(8);   // 8 days from now
    windowStart.setHours(0, 0, 0, 0);
    windowEnd.setHours(23, 59, 59, 999);

    const subs = await Subscription.findAll({
        where: {
            status:   'ACTIVE',
            end_date: { [Op.between]: [windowStart, windowEnd] },
        },
        include: [
            { model: Voiture,           as: 'vehicle', attributes: ['id', 'nickname', 'marque', 'model', 'immatriculation'] },
            { model: SubscriptionPlan,  as: 'plan',    attributes: ['name'] },
        ],
    });

    logger.info(`[EXPIRY SERVICE] 7-day warning: ${subs.length} subscription(s) found`);

    let sent = 0;
    let errors = 0;

    for (const sub of subs) {
        try {
            const vehicleName = sub.vehicle ? _vehicleName(sub.vehicle) : `Vehicle #${sub.vehicle_id}`;
            const expiryDate  = _fmtDate(sub.end_date);

            await notificationCtrl.sendToUser(sub.user_id, {
                title: '⚠️ Subscription Expiring Soon',
                body:  `${vehicleName}'s subscription expires on ${expiryDate}. Renew now to keep tracking.`,
                data:  {
                    type:            'subscription_expiry_warning',
                    vehicle_id:      String(sub.vehicle_id),
                    subscription_id: String(sub.id),
                    expiry_date:     sub.end_date.toISOString(),
                    days_remaining:  '7',
                },
            });

            sent++;
        } catch (err) {
            errors++;
            logger.error(`[EXPIRY SERVICE] 7-day warning failed for sub ${sub.id}:`, err.message);
        }
    }

    return { sent, errors };
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Same-day expiry push (sub expired today)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find subscriptions that expired TODAY (end_date between midnight and 23:59).
 * These were just marked EXPIRED in Step 1. Send a "your sub has expired" push.
 */
const _sendExpiryTodayNotifications = async () => {
    const subs = await Subscription.findAll({
        where: {
            status:   'EXPIRED',
            end_date: { [Op.between]: [_todayStart(), _todayEnd()] },
        },
        include: [
            { model: Voiture, as: 'vehicle', attributes: ['id', 'nickname', 'marque', 'model', 'immatriculation'] },
        ],
    });

    logger.info(`[EXPIRY SERVICE] Expired today: ${subs.length} subscription(s)`);

    let sent = 0;
    let errors = 0;

    for (const sub of subs) {
        try {
            const vehicleName = sub.vehicle ? _vehicleName(sub.vehicle) : `Vehicle #${sub.vehicle_id}`;

            await notificationCtrl.sendToUser(sub.user_id, {
                title: '🔴 Subscription Expired',
                body:  `Tracking for ${vehicleName} has been paused. Renew your subscription to restore access.`,
                data:  {
                    type:            'subscription_expired',
                    vehicle_id:      String(sub.vehicle_id),
                    subscription_id: String(sub.id),
                    expiry_date:     sub.end_date.toISOString(),
                },
            });

            sent++;
        } catch (err) {
            errors++;
            logger.error(`[EXPIRY SERVICE] Expiry-today push failed for sub ${sub.id}:`, err.message);
        }
    }

    return { sent, errors };
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main function called by the cron job.
 * Returns a summary object for logging.
 */
const sendExpiryReminders = async () => {
    logger.info('[EXPIRY SERVICE] ─────── Starting daily expiry cycle ───────');

    const summary = {
        expiredCount:    0,
        totalPushSent:   0,
        totalErrors:     0,
    };

    // 1. Mark overdue rows as EXPIRED first so Step 3 picks them up
    try {
        summary.expiredCount = await _expireOverdueSubscriptions();
    } catch (err) {
        logger.error('[EXPIRY SERVICE] Failed to expire overdue subscriptions:', err.message);
        summary.totalErrors++;
    }

    // 2. 7-day advance warnings
    try {
        const { sent, errors } = await _sendSevenDayWarnings();
        summary.totalPushSent += sent;
        summary.totalErrors   += errors;
    } catch (err) {
        logger.error('[EXPIRY SERVICE] 7-day warning step failed:', err.message);
        summary.totalErrors++;
    }

    // 3. Same-day expiry notifications
    try {
        const { sent, errors } = await _sendExpiryTodayNotifications();
        summary.totalPushSent += sent;
        summary.totalErrors   += errors;
    } catch (err) {
        logger.error('[EXPIRY SERVICE] Today-expiry step failed:', err.message);
        summary.totalErrors++;
    }

    logger.info(
        `[EXPIRY SERVICE] ─── Done — expired: ${summary.expiredCount}, ` +
        `pushes sent: ${summary.totalPushSent}, errors: ${summary.totalErrors} ───`
    );

    return summary;
};

module.exports = { sendExpiryReminders };