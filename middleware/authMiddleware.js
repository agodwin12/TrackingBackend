// middleware/authMiddleware.js
const jwt        = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const User       = require('../models/userModel');
const logger     = require('../utils/logger');
const redisClient = require('../config/redis');

// ─── JWKS client (caches signing keys automatically) ─────────────────────────

const jwks = jwksClient({
    jwksUri:             process.env.KEYCLOAK_JWKS_URL,
    requestHeaders:      {},
    timeout:             10000,
    cache:               true,
    cacheMaxEntries:     5,
    cacheMaxAge:         600000, // 10 minutes
    rateLimit:           true,
    jwksRequestsPerMinute: 10,
});

const ISSUER           = process.env.KEYCLOAK_ISSUER;
const ALLOWED_AUDIENCES = ['tracking_app', 'recouvrement_app'];

// ─── Get signing key from JWKS ────────────────────────────────────────────────

function getSigningKey(header) {
    return new Promise((resolve, reject) => {
        jwks.getSigningKey(header.kid, (err, key) => {
            if (err) return reject(err);
            resolve(key.getPublicKey());
        });
    });
}

// ─── Verify Keycloak RS256 token ──────────────────────────────────────────────

async function verifyKeycloakToken(token) {
    // Decode header first to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded?.header?.kid) throw new Error('Invalid token structure');

    const signingKey = await getSigningKey(decoded.header);

    // Verify signature, issuer, expiry — audience is a list so we check manually
    const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        issuer:     ISSUER,
    });

    // Audience check — token aud can be a string or array
    const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const hasValidAud = tokenAud.some(a => ALLOWED_AUDIENCES.includes(a));
    if (!hasValidAud) throw new Error(`Invalid audience: ${tokenAud}`);

    return payload;
}

// ─── Resolve local DB user from keycloak_id (Redis-cached) ───────────────────

async function resolveLocalUser(keycloakId) {
    const cacheKey = `user:kc:${keycloakId}`;

    const cached = await redisClient.get(cacheKey);
    if (cached) {
        try { return JSON.parse(cached); } catch { /* fall through */ }
    }

    const user = await User.findOne({
        where:      { keycloak_id: keycloakId },
        attributes: ['id', 'user_unique_id', 'phone', 'partner_id', 'keycloak_id'],
    });

    if (!user) return null;

    const plain = user.toJSON();
    // Cache for 5 minutes — short enough to pick up keycloak_id lazy-population
    await redisClient.setEx(cacheKey, 300, JSON.stringify(plain));

    return plain;
}

// ─── Determine app_client from token audience ─────────────────────────────────

function resolveAppClient(payload) {
    // azp (authorized party) is the most reliable — it's the client that requested the token
    if (payload.azp && ALLOWED_AUDIENCES.includes(payload.azp)) return payload.azp;

    // Fallback to aud
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return aud.find(a => ALLOWED_AUDIENCES.includes(a)) || null;
}

// ─── Main middleware ──────────────────────────────────────────────────────────

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token      = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        let payload;
        try {
            payload = await verifyKeycloakToken(token);
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({
                    message: 'Session expired. Please login again.',
                    code:    'TOKEN_EXPIRED',
                });
            }
            logger.warn(`❌ Token verification failed: ${err.message}`);
            return res.status(401).json({ message: 'Invalid token', code: 'INVALID_TOKEN' });
        }

        // Resolve local user from keycloak sub
        const keycloakId = payload.sub;
        const localUser  = await resolveLocalUser(keycloakId);

        if (!localUser) {
            logger.warn(`❌ No local user for keycloak_id=${keycloakId}`);
            return res.status(401).json({ message: 'User account not found', code: 'USER_NOT_FOUND' });
        }

        // Extract client roles
        const appClient  = resolveAppClient(payload);
        const clientRoles = payload?.resource_access?.[appClient]?.roles || [];

        // Populate req.user — same id contract as before + Keycloak extras
        req.user = {
            id:             localUser.id,
            user_unique_id: localUser.user_unique_id,
            phone:          localUser.phone,
            partner_id:     localUser.partner_id,
            keycloak_id:    keycloakId,
            app_client:     appClient,
            roles:          clientRoles,
        };

        logger.debug(`✅ Auth OK — user ${localUser.id} | client=${appClient} | roles=${clientRoles}`);
        return next();

    } catch (err) {
        logger.error('🔥 Auth middleware error:', err.message);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = authMiddleware;