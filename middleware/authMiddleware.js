// middleware/authMiddleware.js
//
// Verifies Keycloak RS256 access tokens via JWKS.
// On success → looks up local user by keycloak_id (cached in Redis 5 min)
//              → sets req.user = { id, phone, user_unique_id, app_type, app_client }
// On expiry  → uses httpOnly refresh-token cookie to get a new Keycloak token,
//              rotates the cookie, returns new access token in X-New-Access-Token.
//
const jwksClient   = require('jwks-rsa');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const User          = require('../models/userModel');
const keycloakService = require('../services/keycloakService');
const redisClient   = require('../config/redis');
const logger        = require('../utils/logger');

// ─── JWKS client (one instance, internally caches public keys) ───────────────
const KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL;
const KEYCLOAK_REALM    = process.env.KEYCLOAK_REALM;

const JWKS_URI = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;

// jose RemoteJWKSet handles key caching and rotation automatically
const JWKS = createRemoteJWKSet(new URL(JWKS_URI));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify a Keycloak RS256 access token.
 * Returns the decoded payload or throws.
 */
async function verifyKeycloakToken(token) {
    const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
    });
    return payload;
}

/**
 * Resolve internal user from Keycloak subject (sub).
 * Result is cached in Redis for 5 minutes to avoid a DB hit on every request.
 */
async function resolveUser(sub) {
    const cacheKey = `kc:uid:${sub}`;

    // Try cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
        try { return JSON.parse(cached); } catch (_) { /* fall through */ }
    }

    // DB lookup
    const user = await User.findOne({
        where: { keycloak_id: sub },
        attributes: ['id', 'phone', 'user_unique_id', 'partner_id', 'type_partner'],
    });

    if (!user) return null;

    const isChauffeur = user.partner_id !== null && user.partner_id !== undefined;
    const app_type    = user.type_partner === 'LEASE_PARTNER' ? 'recouvrement' : 'tracking';

    const resolved = {
        id:             user.id,
        phone:          user.phone,
        user_unique_id: user.user_unique_id,
        app_type,
        isChauffeur,
    };

    // Cache for 5 minutes
    await redisClient.setEx(cacheKey, 300, JSON.stringify(resolved));

    return resolved;
}

/**
 * Set the Keycloak refresh token cookie (mirrors authController).
 */
function setRefreshCookie(res, refreshToken, expiresIn) {
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   expiresIn * 1000,
    });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

const authMiddleware = async (req, res, next) => {
    try {
        // STEP 1: Extract Bearer token
        const authHeader = req.headers.authorization;
        const accessToken = authHeader?.split(' ')[1];

        if (!accessToken) {
            logger.warn('❌ No access token provided');
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        // STEP 2: Verify token against Keycloak JWKS
        let payload;
        try {
            payload = await verifyKeycloakToken(accessToken);

        } catch (tokenError) {
            const isExpired =
                tokenError.code === 'ERR_JWT_EXPIRED' ||
                tokenError.message?.includes('expired');

            if (!isExpired) {
                // Malformed / wrong signature / wrong algorithm
                logger.warn(`❌ Invalid access token: ${tokenError.message}`);
                return res.status(401).json({ message: 'Invalid token' });
            }

            // ── STEP 3: Token expired → try refresh ──────────────────────────
            logger.info('⏰ Access token expired, attempting Keycloak refresh...');

            const refreshToken = req.cookies?.refreshToken;
            if (!refreshToken) {
                logger.warn('❌ No refresh token cookie found');
                return res.status(401).json({
                    message: 'Session expired. Please login again.',
                    code:    'TOKEN_EXPIRED',
                });
            }

            // Decode expired token just to get azp (client_id) — no verify needed
            // jose exposes the header/payload even on expired tokens via decodeJwt
            let clientId;
            try {
                const { decodeJwt } = require('jose');
                const expiredPayload = decodeJwt(accessToken);
                clientId = expiredPayload.azp; // 'tracking_app' | 'recouvrement_app'
            } catch (_) { /* leave clientId undefined */ }

            if (!clientId) {
                logger.warn('❌ Cannot determine client_id from expired token');
                return res.status(401).json({
                    message: 'Session expired. Please login again.',
                    code:    'TOKEN_EXPIRED',
                });
            }

            // STEP 4: Call Keycloak to refresh
            let tokenData;
            try {
                tokenData = await keycloakService.refreshToken(refreshToken, clientId);
            } catch (refreshError) {
                logger.warn(`❌ Keycloak refresh failed: ${refreshError.message}`);
                const code = refreshError.message === 'REFRESH_TOKEN_EXPIRED'
                    ? 'REFRESH_TOKEN_EXPIRED'
                    : 'INVALID_REFRESH_TOKEN';
                return res.status(401).json({
                    message: 'Session expired. Please login again.',
                    code,
                });
            }

            // STEP 5: Verify new access token and continue
            try {
                payload = await verifyKeycloakToken(tokenData.access_token);
            } catch (verifyError) {
                logger.error(`❌ New access token from Keycloak failed verification: ${verifyError.message}`);
                return res.status(401).json({
                    message: 'Authentication error. Please login again.',
                    code:    'INVALID_REFRESH_TOKEN',
                });
            }

            // Rotate cookie and expose new access token to Flutter
            setRefreshCookie(res, tokenData.refresh_token, tokenData.refresh_expires_in);
            res.setHeader('X-New-Access-Token', tokenData.access_token);

            // Persist new refresh token in DB (non-blocking)
            User.findOne({ where: { keycloak_id: payload.sub }, attributes: ['id'] })
                .then(u => u?.update({
                    refresh_token:            tokenData.refresh_token,
                    refresh_token_expires_at: new Date(Date.now() + tokenData.refresh_expires_in * 1000),
                }))
                .catch(err => logger.error('⚠️ Failed to persist rotated refresh token:', err.message));

            logger.info(`🔄 Token auto-refreshed via Keycloak for sub=${payload.sub} client=${clientId}`);
        }

        // STEP 6: Resolve internal user from keycloak_id (sub)
        const user = await resolveUser(payload.sub);

        if (!user) {
            logger.warn(`❌ No local user found for keycloak sub=${payload.sub}`);
            return res.status(401).json({ message: 'User not found. Please contact support.' });
        }

        // STEP 7: Populate req.user — all controllers use req.user.id (internal MySQL id)
        req.user = {
            id:             user.id,
            phone:          user.phone,
            user_unique_id: user.user_unique_id,
            app_type:       user.app_type,
            isChauffeur:    user.isChauffeur,
            app_client:     payload.azp,   // 'tracking_app' | 'recouvrement_app'
            keycloak_sub:   payload.sub,
        };

        logger.info(`✅ Authenticated user ${user.id} | app_type=${user.app_type} | client=${payload.azp}`);
        return next();

    } catch (error) {
        logger.error('🔥 Auth middleware error:', error);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = authMiddleware;