// controllers/authController.js
const User         = require("../models/userModel");
const Voiture      = require("../models/voiture");
const Subscription = require("../models/subscription");
const AssociationUserVoiture             = require("../models/AssociationUserVoiture");
const AssociationChauffeurVoiturePartner = require("../models/associationChauffeurVoiturePartner");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { Op }  = require("sequelize");
const { validationResult } = require("express-validator");
const logger  = require("../utils/logger");

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
    throw new Error(
        "❌ FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must both be set in .env"
    );
}

const ACCESS_TOKEN_EXPIRY  = "1h";
const REFRESH_TOKEN_EXPIRY = "180d";
const REFRESH_TOKEN_DAYS   = 180;

const VOITURE_ATTRIBUTES = [
    'id', 'voiture_unique_id', 'immatriculation', 'mac_id_gps',
    'marque', 'model', 'couleur', 'photo', 'nickname', 'latitude', 'longitude',
];

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

const normalizePhone = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
    return cleaned;
};

function getUserType(user) {
    return (user.partner_id !== null && user.partner_id !== undefined)
        ? 'chauffeur'
        : 'regular';
}

async function fetchRegularUserVehicles(userId) {
    const rows = await AssociationUserVoiture.findAll({
        where:   { user_id: userId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
    });
    return rows.map(r => r.voiture).filter(v => v !== null);
}

async function fetchChauffeurVehicles(chauffeurId) {
    const rows = await AssociationChauffeurVoiturePartner.findAll({
        where:   { chauffeur_id: chauffeurId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
        order:   [['assigned_at', 'DESC']],
    });
    return rows.map(r => r.voiture).filter(v => v !== null);
}

async function fetchVehicleSubscriptionMap(userId, vehicleIds) {
    if (!vehicleIds || vehicleIds.length === 0) return new Map();

    const now = new Date();

    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`🔍 [SUB MAP] Checking subscriptions`);
    logger.info(`   userId     : ${userId}`);
    logger.info(`   vehicleIds : [${vehicleIds.join(', ')}]`);
    logger.info(`   now (UTC)  : ${now.toISOString()}`);

    // ── STEP A: fetch ALL rows for this user+vehicles, no filter at all.
    // This reveals what exists before status/date filtering is applied.
    const allSubs = await Subscription.findAll({
        where: {
            user_id:    userId,
            vehicle_id: { [Op.in]: vehicleIds },
        },
        attributes: ['id', 'vehicle_id', 'status', 'end_date', 'user_id'],
    });

    logger.info(`\n📋 [SUB MAP] ALL rows (no filter) — found ${allSubs.length}:`);
    if (allSubs.length === 0) {
        logger.warn(`   ⚠️  NONE — subscriptions table has no rows matching user_id=${userId} + these vehicle_ids`);
        logger.warn(`   → Check: correct user_id? correct vehicle_id(s)? correct table name?`);
    } else {
        allSubs.forEach(s => {
            const endDate    = s.end_date ? new Date(s.end_date) : null;
            const notExpired = endDate ? endDate > now : false;
            const statusOk   = s.status === 'ACTIVE';
            logger.info(
                `   id=${s.id} | vehicle_id=${s.vehicle_id} | ` +
                `status="${s.status}" (==='ACTIVE': ${statusOk}) | ` +
                `end_date=${endDate ? endDate.toISOString() : 'NULL'} | ` +
                `end_date > now: ${notExpired}`
            );
            // Flag the exact failure reason
            if (!statusOk) {
                logger.warn(`   ❌ BLOCKED: status is "${s.status}", expected "ACTIVE" (exact case match)`);
            }
            if (endDate === null) {
                logger.warn(`   ❌ BLOCKED: end_date is NULL — the Op.gt filter will exclude this row`);
            } else if (!notExpired) {
                logger.warn(`   ❌ BLOCKED: end_date ${endDate.toISOString()} is in the past`);
            }
        });
    }

    // ── STEP B: apply the real filter
    const activeSubs = await Subscription.findAll({
        where: {
            user_id:    userId,
            vehicle_id: { [Op.in]: vehicleIds },
            status:     'ACTIVE',
            end_date:   { [Op.gt]: now },
        },
        attributes: ['id', 'vehicle_id', 'status', 'end_date'],
    });

    logger.info(`\n✅ [SUB MAP] After filter (status=ACTIVE AND end_date>now) — found ${activeSubs.length}:`);
    if (activeSubs.length === 0) {
        logger.warn(`   ⚠️  NONE passed the filter — see reasons flagged above`);
    } else {
        activeSubs.forEach(s => {
            logger.info(`   id=${s.id} | vehicle_id=${s.vehicle_id} | end_date=${new Date(s.end_date).toISOString()}`);
        });
    }

    const activeSet = new Set(activeSubs.map(s => Number(s.vehicle_id)));

    const map = new Map();
    for (const id of vehicleIds) {
        const result = activeSet.has(Number(id));
        map.set(id, result);
        logger.info(`   📌 vehicle ${id} → has_active_subscription = ${result}`);
    }

    logger.info(`${'─'.repeat(60)}\n`);
    return map;
}

function signAccessToken(user) {
    return jwt.sign(
        {
            id:             user.id,
            phone:          user.phone,
            user_unique_id: user.user_unique_id,
            user_type:      getUserType(user),
        },
        ACCESS_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
}

function signRefreshToken(userId) {
    return jwt.sign(
        { id: userId },
        REFRESH_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );
}

async function issueRefreshToken(user, res) {
    const refreshToken = signRefreshToken(user.id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_DAYS);

    await user.update({
        refresh_token:            refreshToken,
        refresh_token_expires_at: expiresAt,
    });

    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });

    return refreshToken;
}

// ═══════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════
exports.login = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: "Invalid input", errors: errors.array() });
        }

        const { phone, password } = req.body;
        const normalizedPhone = normalizePhone(phone);

        const user = await User.findOne({ where: { phone: normalizedPhone } });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            logger.warn(`❌ Failed login attempt for: ${normalizedPhone}`);
            return res.status(401).json({ message: "Invalid phone number or password" });
        }

        logger.info(`✅ User authenticated: ID=${user.id}`);

        const userType = getUserType(user);

        const vehicles = userType === 'chauffeur'
            ? await fetchChauffeurVehicles(user.id)
            : await fetchRegularUserVehicles(user.id);

        logger.info(`🚗 Found ${vehicles.length} vehicle(s) for user ${user.id}`);
        logger.info(`🚗 Vehicle IDs: [${vehicles.map(v => v.id).join(', ')}]`);

        if (vehicles.length === 0) {
            return res.status(403).json({
                message: "No vehicles assigned to your account. Please contact your administrator.",
            });
        }

        const vehicleIds      = vehicles.map(v => v.id);
        const subscriptionMap = await fetchVehicleSubscriptionMap(user.id, vehicleIds);

        const vehiclesWithSubscription = vehicles.map(v => ({
            ...v.toJSON(),
            has_active_subscription: subscriptionMap.get(Number(v.id)) ?? false,
        }));

        // Log the final array that gets sent to Flutter
        logger.info(`\n📱 [LOGIN RESPONSE] vehicles array sent to Flutter:`);
        vehiclesWithSubscription.forEach(v => {
            logger.info(`   id=${v.id} | nickname="${v.nickname}" | has_active_subscription=${v.has_active_subscription}`);
        });

        const activeCount   = vehiclesWithSubscription.filter(v => v.has_active_subscription).length;
        const inactiveCount = vehicles.length - activeCount;

        if (inactiveCount > 0) {
            const unsubscribedIds = vehiclesWithSubscription
                .filter(v => !v.has_active_subscription)
                .map(v => v.id);
            logger.warn(
                `⚠️  User ${user.id} has ${inactiveCount} vehicle(s) without active subscription` +
                ` — IDs: [${unsubscribedIds.join(', ')}]`
            );
        }

        const subscriptionStatus = activeCount > 0 ? 'ACTIVE' : 'NONE';

        const accessToken  = signAccessToken(user);
        const refreshToken = await issueRefreshToken(user, res);

        logger.info(
            `✅ Login successful — User: ${user.id} | Type: ${userType}` +
            ` | Vehicles: ${vehicles.length} (${activeCount} active sub, ${inactiveCount} without)` +
            ` | Subscription: ${subscriptionStatus}`
        );

        return res.json({
            message:             "Login successful",
            isFirstLogin:        user.is_first_login,
            user_type:           userType,
            subscription_status: subscriptionStatus,
            user: {
                id:             user.id,
                user_unique_id: user.user_unique_id,
                nom:            user.nom,
                prenom:         user.prenom,
                phone:          user.phone,
                email:          user.email,
                ville:          user.ville,
                quartier:       user.quartier,
                photo:          user.photo,
                partner_id:     user.partner_id,
            },
            vehicles:     vehiclesWithSubscription,
            accessToken,
            refreshToken,
        });

    } catch (error) {
        logger.error("🔥 Login error:", error.message);
        logger.error("🔥 Stack:", error.stack);
        return res.status(500).json({ message: "Server error. Please try again later." });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════════════
exports.logout = async (req, res) => {
    try {
        const userId = req.user.id;

        await User.update(
            { refresh_token: null, refresh_token_expires_at: null },
            { where: { id: userId } }
        );

        res.clearCookie('refreshToken', {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'strict',
        });

        logger.info(`✅ User ${userId} logged out`);
        return res.json({ message: "Logged out successfully" });

    } catch (error) {
        logger.error("🔥 Logout error:", error.message);
        return res.status(500).json({ message: "Error logging out" });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REFRESH TOKEN
// ═══════════════════════════════════════════════════════════════════════
exports.refreshToken = async (req, res) => {
    try {
        const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

        if (!refreshToken) {
            return res.status(401).json({ message: "No refresh token provided" });
        }

        let decoded;
        try {
            decoded = jwt.verify(refreshToken, REFRESH_SECRET);
        } catch {
            return res.status(401).json({ message: "Invalid or expired refresh token" });
        }

        const user = await User.findByPk(decoded.id);

        if (!user || user.refresh_token !== refreshToken) {
            return res.status(401).json({ message: "Refresh token revoked or invalid" });
        }

        if (user.refresh_token_expires_at && new Date() > new Date(user.refresh_token_expires_at)) {
            return res.status(401).json({ message: "Refresh token expired" });
        }

        const newAccessToken  = signAccessToken(user);
        const newRefreshToken = await issueRefreshToken(user, res);

        logger.info(`🔄 Refresh token rotated for user ${user.id}`);

        return res.json({
            message:      "Token refreshed successfully",
            accessToken:  newAccessToken,
            refreshToken: newRefreshToken,
        });

    } catch (error) {
        logger.error("🔥 Refresh token error:", error.message);
        return res.status(500).json({ message: "Error refreshing token" });
    }
};