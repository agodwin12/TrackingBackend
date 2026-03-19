// services/emailService.js
const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

// ── Hard-fail on missing Brevo credentials at startup ────────────────────────
const BREVO_USER = process.env.BREVO_SMTP_USER;
const BREVO_PASS = process.env.BREVO_SMTP_PASS;
const FROM_NAME  = process.env.EMAIL_FROM_NAME  || 'FLEETRA';
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || 'no-reply@fleetra.com';

if (!BREVO_USER || !BREVO_PASS) {
    logger.warn('[EMAIL] BREVO_SMTP_USER or BREVO_SMTP_PASS not set — emails will fail');
}

const transporter = nodemailer.createTransport({
    host:   'smtp-relay.brevo.com',
    port:   587,
    secure: false,
    auth: {
        user: BREVO_USER,
        pass: BREVO_PASS,
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML TEMPLATE — subscription expiry reminder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ immatriculation: string, end_date: Date, plan_label: string }[]} vehicles
 * @param {number} daysLeft  — 1, 2, or 3
 */
const _buildExpiryEmailHtml = (vehicles, daysLeft) => {
    const urgencyColor = daysLeft === 1 ? '#dc2626' : daysLeft === 2 ? '#d97706' : '#2563eb';
    const urgencyLabel = daysLeft === 1 ? 'EXPIRES TOMORROW' : `${daysLeft} DAYS LEFT`;

    const rows = vehicles.map(v => {
        const expiry = new Date(v.end_date).toLocaleDateString('fr-FR', {
            day: '2-digit', month: 'long', year: 'numeric',
        });
        return `
        <tr>
            <td style="padding:10px 16px;border-bottom:1px solid #f0f0f0;font-weight:600;color:#1e293b;">${v.immatriculation}</td>
            <td style="padding:10px 16px;border-bottom:1px solid #f0f0f0;color:#475569;">${v.plan_label}</td>
            <td style="padding:10px 16px;border-bottom:1px solid #f0f0f0;color:${urgencyColor};font-weight:600;">${expiry}</td>
        </tr>`;
    }).join('');

    const vehicleWord = vehicles.length === 1 ? 'vehicle' : 'vehicles';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Fleetra Subscription Expiry Reminder</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:${urgencyColor};padding:28px 32px;text-align:center;">
              <p style="margin:0;color:rgba(255,255,255,0.85);font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${urgencyLabel}</p>
              <h1 style="margin:8px 0 0;color:#ffffff;font-size:24px;font-weight:700;">Subscription Expiry Reminder</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">
                Hello,
              </p>
              <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
                The following ${vehicleWord} ${vehicles.length === 1 ? 'has' : 'have'} a subscription expiring in
                <strong style="color:${urgencyColor};">${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.
                Renew now to avoid any interruption in tracking.
              </p>

              <!-- Vehicle table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#f1f5f9;">
                    <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Plate</th>
                    <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Plan</th>
                    <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Expires On</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>

              <!-- CTA -->
              <div style="text-align:center;margin-top:32px;">
                <a href="${process.env.APP_RENEWAL_URL || '#'}"
                   style="display:inline-block;background:${urgencyColor};color:#ffffff;padding:14px 32px;
                          border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;">
                  Renew Subscription
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;">
                You received this email because you have an active subscription with ${FROM_NAME}.<br/>
                © ${new Date().getFullYear()} ${FROM_NAME}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────


const sendExpiryReminderEmail = async (toEmail, vehicles, daysLeft) => {
    const subject = daysLeft === 1
        ? `⚠️ [FLEETRA] Your subscription expires tomorrow`
        : `🔔 [FLEETRA] Your subscription expires in ${daysLeft} days`;

    const html = _buildExpiryEmailHtml(vehicles, daysLeft);

    try {
        const info = await transporter.sendMail({
            from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
            to:      toEmail,
            subject,
            html,
        });

        logger.info(`[EMAIL] Expiry reminder sent → ${toEmail} (${vehicles.length} vehicle(s), ${daysLeft}d) | msgId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        logger.error(`[EMAIL] Failed to send to ${toEmail}:`, err.message);
        return { success: false, error: err.message };
    }
};

module.exports = { sendExpiryReminderEmail };