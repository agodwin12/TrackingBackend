// services/keycloakService.js
const axios = require('axios');
const jwt   = require('jsonwebtoken');
const logger = require('../utils/logger');
const redisClient = require('../config/redis');

const BASE_URL   = process.env.KEYCLOAK_BASE_URL;
const REALM      = process.env.KEYCLOAK_REALM;
const TOKEN_URL  = process.env.KEYCLOAK_TOKEN_URL;
const LOGOUT_URL = process.env.KEYCLOAK_LOGOUT_URL;

const CLIENTS = {
    tracking:     'tracking_app',
    recouvrement: 'recouvrement_app',
};

// Role → app_type mapping
const ROLE_APP_MAP = {
    tracking_app: {
        clientId: CLIENTS.tracking,
        app_type: 'tracking',
        validRoles: [
            'admin', 'ADMIN', 'gestionnaire_plateforme',
            'call_center', 'CALL_CENTER', 'DRIVER',
            'INDIVIDUAL_OWNER', 'PARTNER_ADMIN', 'SITE_MANAGER',
            'SUPER_ADMIN', 'TECH_ADMIN',
        ],
    },
    recouvrement_app: {
        clientId: CLIENTS.recouvrement,
        app_type: 'recouvrement',
        validRoles: ['DRIVER', 'PARTNER_ADMIN'],
    },
};

// ─── Admin token (cached in Redis) ───────────────────────────────────────────

async function getAdminToken() {
    const cacheKey = 'keycloak:admin_token';

    const cached = await redisClient.get(cacheKey);
    if (cached) return cached;

    try {
        const params = new URLSearchParams({
            grant_type: 'password',
            client_id:  process.env.KEYCLOAK_ADMIN_CLIENT_ID,
            username:   process.env.KEYCLOAK_ADMIN_USER,
            password:   process.env.KEYCLOAK_ADMIN_PASSWORD,
        });

        const { data } = await axios.post(
            `${BASE_URL}/realms/master/protocol/openid-connect/token`,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        // Cache with 30s safety margin
        const ttl = (data.expires_in || 300) - 30;
        await redisClient.setEx(cacheKey, ttl, data.access_token);

        logger.info('✅ Keycloak admin token obtained');
        return data.access_token;

    } catch (err) {
        logger.error('❌ Failed to obtain Keycloak admin token:', err.response?.data || err.message);
        throw new Error('Keycloak admin authentication failed');
    }
}

// ─── ROPC login — try one client ─────────────────────────────────────────────

async function attemptLogin(username, password, clientId) {
    try {
        const params = new URLSearchParams({
            grant_type: 'password',
            client_id:  clientId,
            username,
            password,
            scope: 'openid email profile',
        });

        logger.info(`🔑 Keycloak ROPC attempt — url=${TOKEN_URL} client=${clientId} username=${username}`);

        const { data } = await axios.post(
            TOKEN_URL,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        logger.info(`✅ Keycloak login success: client=${clientId} user=${username}`);
        return { success: true, data };

    } catch (err) {
        const status      = err.response?.status;
        const errCode     = err.response?.data?.error;
        const errDesc     = err.response?.data?.error_description;

        // Full Keycloak error detail
        logger.warn(`⚠️ Keycloak ROPC failed — client=${clientId} username=${username} status=${status} error=${errCode} description="${errDesc}"`);

        // 401 / invalid_grant = wrong credentials or user not in this client
        if (status === 401 || errCode === 'invalid_grant' || errCode === 'unauthorized_client') {
            return { success: false, data: null };
        }

        // Anything else (5xx, network) — propagate
        logger.error(`❌ Keycloak login error client=${clientId}:`, err.response?.data || err.message);
        throw new Error('Keycloak service unavailable');
    }
}

// ─── Sequential double-check login ───────────────────────────────────────────
// Try tracking_app first, then recouvrement_app.
// Returns { tokenData, clientId } or throws.

async function loginWithFallback(phone, password) {
    const username = phone;

    logger.info(`🔍 loginWithFallback — keycloak username="${username}"`);
    logger.info(`🔍 TOKEN_URL="${TOKEN_URL}" REALM="${REALM}"`);

    // Attempt 1: tracking_app — only accept if user has tracking roles
    const trackingResult = await attemptLogin(username, password, CLIENTS.tracking);
    if (trackingResult.success) {
        const decoded     = jwt.decode(trackingResult.data.access_token);
        const clientRoles = decoded?.resource_access?.[CLIENTS.tracking]?.roles || [];
        const validRoles  = ROLE_APP_MAP[CLIENTS.tracking].validRoles;
        const hasRole     = clientRoles.some(r => validRoles.includes(r));

        logger.info(`🔍 tracking_app auth OK — roles=${JSON.stringify(clientRoles)} hasValidRole=${hasRole}`);

        if (hasRole) {
            return { tokenData: trackingResult.data, clientId: CLIENTS.tracking };
        }
        logger.info(`ℹ️ User has no tracking roles — trying recouvrement_app`);
    }

    // Attempt 2: recouvrement_app — only accept if user has recouvrement roles
    const recouvrementResult = await attemptLogin(username, password, CLIENTS.recouvrement);
    if (recouvrementResult.success) {
        const decoded     = jwt.decode(recouvrementResult.data.access_token);
        const clientRoles = decoded?.resource_access?.[CLIENTS.recouvrement]?.roles || [];
        const validRoles  = ROLE_APP_MAP[CLIENTS.recouvrement].validRoles;
        const hasRole     = clientRoles.some(r => validRoles.includes(r));

        logger.info(`🔍 recouvrement_app auth OK — roles=${JSON.stringify(clientRoles)} hasValidRole=${hasRole}`);

        if (hasRole) {
            return { tokenData: recouvrementResult.data, clientId: CLIENTS.recouvrement };
        }
        logger.info(`ℹ️ User has no recouvrement roles either`);
    }

    return null;
}

// ─── Decode roles from Keycloak access token payload ─────────────────────────

function extractRolesFromToken(decodedToken, clientId) {
    const clientRoles = decodedToken?.resource_access?.[clientId]?.roles || [];
    const realmRoles  = decodedToken?.realm_access?.roles || [];
    return { clientRoles, realmRoles };
}

// ─── Determine app_type from token ───────────────────────────────────────────

function resolveAppType(clientId, clientRoles) {
    const config = ROLE_APP_MAP[clientId];
    if (!config) return null;

    // Check if user has at least one valid role for this client
    const hasValidRole = clientRoles.some(r => config.validRoles.includes(r));
    if (!hasValidRole) {
        logger.warn(`⚠️ User authenticated to ${clientId} but has no valid roles: ${clientRoles}`);
    }

    return config.app_type;
}

// ─── Refresh token ────────────────────────────────────────────────────────────

async function refreshToken(refreshToken, clientId) {
    try {
        const params = new URLSearchParams({
            grant_type:    'refresh_token',
            client_id:     clientId,
            refresh_token: refreshToken,
        });

        const { data } = await axios.post(
            TOKEN_URL,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        logger.info(`✅ Keycloak token refreshed for client=${clientId}`);
        return data;

    } catch (err) {
        const errCode = err.response?.data?.error;
        logger.warn(`⚠️ Keycloak refresh failed client=${clientId}: ${errCode}`);
        throw new Error(errCode === 'invalid_grant' ? 'REFRESH_TOKEN_EXPIRED' : 'Keycloak service unavailable');
    }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

async function logout(refreshToken, clientId) {
    try {
        const params = new URLSearchParams({
            client_id:     clientId,
            refresh_token: refreshToken,
        });

        await axios.post(
            LOGOUT_URL,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        logger.info(`✅ Keycloak session revoked for client=${clientId}`);

    } catch (err) {
        // Log but don't block — local session cleanup must still happen
        logger.warn(`⚠️ Keycloak logout failed (non-blocking): ${err.response?.data?.error || err.message}`);
    }
}

// ─── Admin: create user in Keycloak ──────────────────────────────────────────

async function createKeycloakUser({ username, email, firstName, lastName, password, phone }) {
    const adminToken = await getAdminToken();

    const payload = {
        username,
        email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: false,
        credentials: [{ type: 'password', value: password, temporary: false }],
        attributes: { phone: [phone] },
    };

    try {
        const response = await axios.post(
            `${BASE_URL}/admin/realms/${REALM}/users`,
            payload,
            { headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' } }
        );

        // Keycloak returns 201 with Location header containing the new user UUID
        const location = response.headers?.location || '';
        const keycloakId = location.split('/').pop();

        logger.info(`✅ Keycloak user created: ${keycloakId}`);
        return keycloakId;

    } catch (err) {
        if (err.response?.status === 409) {
            throw new Error('KEYCLOAK_USER_EXISTS');
        }
        logger.error('❌ Failed to create Keycloak user:', err.response?.data || err.message);
        throw new Error('Failed to create user in Keycloak');
    }
}

// ─── Admin: assign client role to user ───────────────────────────────────────

async function assignClientRole(keycloakUserId, clientId, roleName) {
    const adminToken = await getAdminToken();

    // Step 1: get client UUID
    const { data: clients } = await axios.get(
        `${BASE_URL}/admin/realms/${REALM}/clients?clientId=${clientId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const clientUuid = clients[0]?.id;
    if (!clientUuid) throw new Error(`Client ${clientId} not found in Keycloak`);

    // Step 2: get role object
    const { data: role } = await axios.get(
        `${BASE_URL}/admin/realms/${REALM}/clients/${clientUuid}/roles/${roleName}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    // Step 3: assign
    await axios.post(
        `${BASE_URL}/admin/realms/${REALM}/users/${keycloakUserId}/role-mappings/clients/${clientUuid}`,
        [{ id: role.id, name: role.name }],
        { headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' } }
    );

    logger.info(`✅ Role ${roleName} assigned to user ${keycloakUserId} on client ${clientId}`);
}

// ─── Admin: update user password ─────────────────────────────────────────────

async function resetKeycloakPassword(keycloakId, newPassword) {
    const adminToken = await getAdminToken();

    await axios.put(
        `${BASE_URL}/admin/realms/${REALM}/users/${keycloakId}/reset-password`,
        { type: 'password', value: newPassword, temporary: false },
        { headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' } }
    );

    logger.info(`✅ Keycloak password reset for user ${keycloakId}`);
}

// ─── Admin: delete user ───────────────────────────────────────────────────────

async function deleteKeycloakUser(keycloakId) {
    const adminToken = await getAdminToken();

    await axios.delete(
        `${BASE_URL}/admin/realms/${REALM}/users/${keycloakId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    logger.info(`✅ Keycloak user deleted: ${keycloakId}`);
}

module.exports = {
    loginWithFallback,
    extractRolesFromToken,
    resolveAppType,
    refreshToken,
    logout,
    createKeycloakUser,
    assignClientRole,
    resetKeycloakPassword,
    deleteKeycloakUser,
    CLIENTS,
};