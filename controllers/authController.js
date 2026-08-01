// controllers/authController.js
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const { Op }      = require('sequelize');
const { validationResult } = require('express-validator');

const User                             = require('../models/userModel');
const Voiture                          = require('../models/voiture');
const Subscription                     = require('../models/subscription');
const AssociationUserVoiture           = require('../models/AssociationUserVoiture');
const AssociationChauffeurVoiturePartner = require('../models/associationChauffeurVoiturePartner');
const logger                           = require('../utils/logger');
const keycloakService                  = require('../services/keycloakService');

// ─── Vehicle attributes projected in login response ───────────────────────────
const VOITURE_ATTRIBUTES = [
    'id', 'voiture_unique_id', 'immatriculation', 'mac_id_gps',
    'marque', 'model', 'couleur', 'photo', 'nickname', 'latitude', 'longitude',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const normalizePhone = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
    return cleaned;
};

/**
 * Resolve app destination by looking up the partner's type_partner.
 *
 *   No partner_id          → 'tracking'   (regular owner account)
 *   partner.LEASE_PARTNER  → 'recouvrement'
 *   partner.SIMPLE_PARTNER → 'tracking'
 */
async function resolveAppType(partnerId) {
    if (!partnerId) return 'tracking';

    const partner = await User.findByPk(partnerId, {
        attributes: ['type_partner'],
    });

    if (!partner) {
        logger.warn(`⚠️ Partner ID ${partnerId} not found — defaulting to tracking`);
        return 'tracking';
    }

    return partner.type_partner === 'LEASE_PARTNER' ? 'recouvrement' : 'tracking';
}

async function fetchRegularUserVehicles(userId) {
    const rows = await AssociationUserVoiture.findAll({
        where: { user_id: userId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
    });
    return rows.map(r => r.voiture).filter(Boolean);
}

async function fetchChauffeurVehicles(chauffeurId) {
    const rows = await AssociationChauffeurVoiturePartner.findAll({
        where: { chauffeur_id: chauffeurId },
        include: [{ model: Voiture, as: 'voiture', attributes: VOITURE_ATTRIBUTES }],
        order: [['assigned_at', 'DESC']],
    });
    return rows.map(r => r.voiture).filter(Boolean);
}

// Partner staff (role_id 6, "Administrateur partenaire") aren't chauffeurs
// themselves — they have no row of their own in
// association_chauffeur_voiture_partner. What they see instead is every
// vehicle assigned to ANY chauffeur under the same partner (their super
// admin's whole fleet). No Sequelize association exists from that table to
// User for the chauffeur side, so this joins directly.
async function fetchPartnerFleetVehicles(partnerId) {
    const attrs = VOITURE_ATTRIBUTES.map(a => `v.${a}`).join(', ');
    const rows = await Voiture.sequelize.query(
        `SELECT DISTINCT ${attrs}
         FROM association_chauffeur_voiture_partner acvp
         JOIN users chauffeur ON chauffeur.id = acvp.chauffeur_id
         JOIN voitures v ON v.id = acvp.voiture_id
         WHERE chauffeur.partner_id = :partnerId`,
        { replacements: { partnerId }, type: Voiture.sequelize.QueryTypes.SELECT }
    );
    return rows;
}

async function fetchVehicleSubscriptionMap(userId, vehicleIds) {
    if (!vehicleIds?.length) return new Map();

    const now = new Date();
    const active = await Subscription.findAll({
        where: {
            user_id: userId,
            vehicle_id: { [Op.in]: vehicleIds },
            status: 'ACTIVE',
            end_date: { [Op.gt]: now },
        },
        attributes: ['vehicle_id'],
    });

    const activeSet = new Set(active.map(s => Number(s.vehicle_id)));
    const map = new Map();
    for (const id of vehicleIds) map.set(id, activeSet.has(Number(id)));
    return map;
}

// Partner staff aren't the subscriber on any of the fleet's vehicles — each
// one's subscription belongs to whichever driver/owner it's actually
// assigned to. So this checks by vehicle_id alone, not by requesting user.
async function fetchFleetSubscriptionMap(vehicleIds) {
    if (!vehicleIds?.length) return new Map();

    const now = new Date();
    const active = await Subscription.findAll({
        where: {
            vehicle_id: { [Op.in]: vehicleIds },
            status: 'ACTIVE',
            end_date: { [Op.gt]: now },
        },
        attributes: ['vehicle_id'],
    });

    const activeSet = new Set(active.map(s => Number(s.vehicle_id)));
    const map = new Map();
    for (const id of vehicleIds) map.set(id, activeSet.has(Number(id)));
    return map;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

exports.login = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: 'Invalid input', errors: errors.array() });
        }

        const { phone, password } = req.body;
        const normalizedPhone = normalizePhone(phone);

        logger.info(`🔹 Login attempt: ${normalizedPhone}`);

        // STEP 1: Find user in local DB
        const user = await User.findOne({ where: { phone: normalizedPhone } });

        if (!user) {
            logger.warn(`❌ User not found: ${normalizedPhone}`);
            return res.status(401).json({ message: 'Invalid phone number or password' });
        }

        // STEP 2: Authenticate against Keycloak
        const keycloakUsername = normalizedPhone;
        const result = await keycloakService.loginWithFallback(keycloakUsername, password);

        if (!result) {
            logger.warn(`❌ Keycloak rejected credentials for: ${normalizedPhone}`);
            return res.status(401).json({ message: 'Invalid phone number or password' });
        }

        const { tokenData, clientId } = result;

        // STEP 3: Decode Keycloak access token
        const decodedToken = jwt.decode(tokenData.access_token);
        const keycloakId   = decodedToken?.sub;

        // STEP 4: Lazy-populate keycloak_id on first Keycloak login
        if (!user.keycloak_id && keycloakId) {
            await user.update({ keycloak_id: keycloakId });
            logger.info(`✅ keycloak_id populated for user ${user.id}: ${keycloakId}`);
        }

        // STEP 5: Extract Keycloak roles
        const { clientRoles } = keycloakService.extractRolesFromToken(decodedToken, clientId);

        // STEP 6: Resolve app_type
        //
        //   Partner staff (role_id 6, "Administrateur partenaire") always land
        //   in tracking, regardless of their partner's type — they're fleet
        //   staff, not a driver on a lease/recouvrement program.
        //
        //   Otherwise, by partner's type_partner:
        //     No partner_id          → tracking   (regular owner)
        //     partner.LEASE_PARTNER  → recouvrement
        //     partner.SIMPLE_PARTNER → tracking
        //
        const hasPartner     = user.partner_id !== null && user.partner_id !== undefined;
        const isPartnerStaff = user.role_id === 6 && hasPartner;
        const isChauffeur    = hasPartner && !isPartnerStaff;
        const app_type       = isPartnerStaff ? 'tracking' : await resolveAppType(user.partner_id);

        logger.info(`👤 User ${user.id} | partner_id=${user.partner_id} | app_type=${app_type} | isChauffeur=${isChauffeur} | isPartnerStaff=${isPartnerStaff} | client=${clientId} | roles=${clientRoles}`);

        // STEP 7: Tracking-only — fetch vehicles and subscriptions
        //   Recouvrement users skip this block entirely.
        let vehiclesWithSubs   = [];
        let subscriptionStatus = 'NONE';

        if (app_type === 'tracking') {
            const vehicles = isPartnerStaff
                ? await fetchPartnerFleetVehicles(user.partner_id)
                : isChauffeur
                    ? await fetchChauffeurVehicles(user.id)
                    : await fetchRegularUserVehicles(user.id);

            if (vehicles.length === 0) {
                logger.warn(`❌ No vehicles for user ${user.id}`);
                return res.status(403).json({
                    message: 'No vehicles assigned to your account. Please contact your administrator.',
                });
            }

            const vehicleIds = vehicles.map(v => v.id);
            const subMap     = isPartnerStaff
                ? await fetchFleetSubscriptionMap(vehicleIds)
                : await fetchVehicleSubscriptionMap(user.id, vehicleIds);

            vehiclesWithSubs = vehicles.map(v => ({
                ...(typeof v.toJSON === 'function' ? v.toJSON() : v),
                has_active_subscription: subMap.get(Number(v.id)) ?? false,
            }));

            subscriptionStatus = vehiclesWithSubs.some(v => v.has_active_subscription) ? 'ACTIVE' : 'NONE';
            logger.info(`📋 Subscription: ${subscriptionStatus} | vehicles: ${vehicles.length}`);
        }

        // STEP 8: Store Keycloak refresh token for logout use
        await user.update({
            refresh_token:            tokenData.refresh_token,
            refresh_token_expires_at: new Date(Date.now() + tokenData.refresh_expires_in * 1000),
        });

        // STEP 9: Set refresh token in httpOnly cookie
        res.cookie('refreshToken', tokenData.refresh_token, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge:   tokenData.refresh_expires_in * 1000,
        });

        logger.info(`✅ Login success — user ${user.id} | app_type=${app_type}`);

        // STEP 10: Respond
        return res.json({
            message:             'Login successful',
            isFirstLogin:        user.is_first_login,
            app_type,                                   // 'tracking' | 'recouvrement' ← Flutter routes on this
            client_id:           clientId,
            roles:               clientRoles,
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
            vehicles:     vehiclesWithSubs,
            accessToken:  tokenData.access_token,    // Keycloak RS256 token — works for both apps
            refreshToken: tokenData.refresh_token,
            expiresIn:    tokenData.expires_in,
        });

    } catch (err) {
        logger.error('🔥 Login error:', err.message);
        return res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

exports.logout = async (req, res) => {
    try {
        const userId   = req.user.id;
        const clientId = req.user.app_client;

        const refreshToken = req.cookies?.refreshToken
            || (await User.findByPk(userId, { attributes: ['refresh_token'] }))?.refresh_token;

        if (refreshToken && clientId) {
            await keycloakService.logout(refreshToken, clientId);
        }

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
        return res.json({ message: 'Logged out successfully' });

    } catch (err) {
        logger.error('🔥 Logout error:', err.message);
        return res.status(500).json({ message: 'Error logging out' });
    }
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────

exports.refreshToken = async (req, res) => {
    try {
        let storedRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
        const clientId         = req.body?.client_id;

        if (!storedRefreshToken) {
            return res.status(401).json({ message: 'No refresh token provided' });
        }

        if (!clientId) {
            return res.status(400).json({ message: 'client_id required for token refresh' });
        }

        const tokenData = await keycloakService.refreshToken(storedRefreshToken, clientId);

        // Update stored refresh token
        const decoded = jwt.decode(tokenData.access_token);
        if (decoded?.sub) {
            await User.update(
                {
                    refresh_token:            tokenData.refresh_token,
                    refresh_token_expires_at: new Date(Date.now() + tokenData.refresh_expires_in * 1000),
                },
                { where: { keycloak_id: decoded.sub } }
            );
        }

        // Rotate cookie
        res.cookie('refreshToken', tokenData.refresh_token, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge:   tokenData.refresh_expires_in * 1000,
        });

        logger.info(`✅ Token refreshed for client=${clientId}`);

        return res.json({
            message:      'Token refreshed successfully',
            accessToken:  tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresIn:    tokenData.expires_in,
        });

    } catch (err) {
        if (err.message === 'REFRESH_TOKEN_EXPIRED') {
            return res.status(401).json({
                message: 'Session expired. Please login again.',
                code:    'REFRESH_TOKEN_EXPIRED',
            });
        }
        logger.error('🔥 Refresh token error:', err.message);
        return res.status(500).json({ message: 'Error refreshing token' });
    }
};