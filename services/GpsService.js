// services/GpsService.js
const axios = require("axios");

// ==============================
// Provider endpoints / settings
// ==============================
const GPS_API_URL =
    process.env.GPS_API_URL || "http://apitest.18gps.net/GetDateServices.asmx";

const LOGIN_URL = `${GPS_API_URL}/loginSystem`;
const COMMAND_URL = `${GPS_API_URL}/GetDate`;

const GPS_LOGIN_TYPE = process.env.GPS_LOGIN_TYPE || "ENTERPRISE";
const GPS_LANGUAGE = process.env.GPS_LANGUAGE || "en";
const GPS_TIMEZONE = Number(process.env.GPS_TIMEZONE || 8);
const GPS_LOGIN_URL = process.env.GPS_LOGIN_URL || "http://appzzl.18gps.net/";
const GPS_MAP_TYPE = process.env.GPS_MAP_TYPE || "WGS84";

// ==============================
// Accounts credentials
// ==============================
const GPS_ACCOUNTS = {
    tracking: {
        loginName: process.env.GPS_LOGIN_NAME_1 || "Proxym_tracking",
        loginPassword: process.env.GPS_LOGIN_PASSWORD_1 || "proxym123",
    },
    mobility: {
        loginName: process.env.GPS_LOGIN_NAME_2 || "PROXYM",
        loginPassword: process.env.GPS_LOGIN_PASSWORD_2 || "Proxym2024.",
    },
};

// ==============================
// Axios defaults
// ==============================
const DEFAULT_TIMEOUT = Number(process.env.GPS_HTTP_TIMEOUT || 15000);

// =======================================
// Helpers
// =======================================
function nowIso() {
    try {
        return new Date().toISOString();
    } catch {
        return "";
    }
}

function normalizeAccountName(accountName) {
    const v = String(accountName || "").trim().toLowerCase();
    if (v === "tracking" || v === "mobility") return v;
    return null;
}

function getCredentialsForAccount(accountName) {
    const key = normalizeAccountName(accountName);
    if (!key) return null;
    return GPS_ACCOUNTS[key] || null;
}

/**
 * GET wrapper
 */
async function getWithParams(url, params, headers = {}, timeout = DEFAULT_TIMEOUT) {
    const res = await axios.get(url, { params, headers, timeout });
    return res.data;
}

/**
 * Some endpoints return boolean-like values as strings/numbers; coerce.
 */
function toBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
        const s = v.toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
    }
    return undefined;
}

/**
 * Normalize "status bitfield" strings like "10100000".
 * We only care about 1st (ACC) and 3rd (oil/relay) bits per your app.
 * Returns: { accState?: boolean, oilState?: boolean }
 */
function parseStatusBits(status) {
    if (typeof status !== "string" || status.length < 3) return {};
    return {
        accState: status[0] === "1",
        oilState: status[2] === "1",
    };
}

/**
 * Normalize provider status response:
 * Returns:
 * {
 *   success: boolean,
 *   gps_status?: string,
 *   speed?: number,
 *   status?: string,
 *   oilState?: boolean,
 *   accState?: boolean,
 *   raw: any,
 *   message?: string
 * }
 */
function normalizeStatusResponse(body) {
    if (!body) return { success: false, message: "Empty response" };

    // handle shapes like { success, data: {...} } or flat {...}
    const data = body.data ?? body;

    const success =
        body.success === true ||
        body.success === "true" ||
        body.code === 0 ||
        data.success === true ||
        data.success === "true";

    const gps_status =
        data.gps_status ??
        data.gpsStatus ??
        data.gps ??
        body.gps_status ??
        body.gpsStatus;

    const speed = data.speed ?? data.gps_speed ?? body.speed;

    const statusField = data.status ?? data.powerStatus ?? body.status;

    const oilState = toBool(data.oilState ?? body.oilState);
    const accState = toBool(data.accState ?? body.accState);

    const normalized = {
        success: !!success,
        gps_status: gps_status ?? "Unknown",
        speed: typeof speed === "number" ? speed : Number(speed ?? 0) || 0,
        status: typeof statusField === "string" ? statusField : undefined,
        oilState,
        accState,
        raw: data,
        message: body.msg || body.message || data.msg || data.message,
    };

    // If explicit flags are not present but we have a bitfield string, derive them.
    if (normalized.status && (oilState === undefined || accState === undefined)) {
        const bits = parseStatusBits(normalized.status);
        if (normalized.oilState === undefined && bits.oilState !== undefined) {
            normalized.oilState = bits.oilState;
        }
        if (normalized.accState === undefined && bits.accState !== undefined) {
            normalized.accState = bits.accState;
        }
    }

    // If gps_status returns "1"/"0"
    if (normalized.gps_status === "1") normalized.gps_status = "Connected";
    if (normalized.gps_status === "0") normalized.gps_status = "Disconnected";

    return normalized;
}

/**
 * Extract provider error code consistently
 */
function extractErrorCode(resp) {
    if (!resp) return null;
    return resp.errorCode ?? resp.error_code ?? resp.code ?? resp.statusCode ?? null;
}

/**
 * Determine if response indicates token is invalid/expired.
 * 18gps sometimes returns errorCode=403 or 401-ish.
 */
function isTokenInvalid(resp) {
    const code = extractErrorCode(resp);
    if (code === 403 || code === "403") return true;
    if (code === 401 || code === "401") return true;

    const msg = String(resp?.errorDescribe || resp?.msg || resp?.message || "").toLowerCase();
    if (msg.includes("token") && (msg.includes("invalid") || msg.includes("expire"))) return true;
    if (msg.includes("mds") && (msg.includes("invalid") || msg.includes("expire"))) return true;

    return false;
}

/**
 * Decide if a command succeeded.
 * For SendCommands, 18gps often uses success="true" and/or errorCode="200".
 */
function isCommandOk(providerResp) {
    if (!providerResp) return false;
    return (
        providerResp.success === true ||
        providerResp.success === "true" ||
        providerResp.errorCode === "200" ||
        providerResp.errorCode === 200
    );
}

/**
 * Get readable provider message.
 */
function getProviderMessage(providerResp) {
    const first = Array.isArray(providerResp?.data) && providerResp.data.length ? providerResp.data[0] : null;
    return (
        first?.ReturnMsg ||
        providerResp?.errorDescribe ||
        providerResp?.msg ||
        providerResp?.message ||
        null
    );
}

// =======================================
// Public API
// =======================================

/**
 * Login to GPS system for a specific account and retrieve token (mds).
 * NO CACHING: always returns a fresh token.
 *
 * @param {string} accountName "tracking" | "mobility"
 * @returns {Promise<string|null>}
 */
async function loginGps(accountName) {
    const creds = getCredentialsForAccount(accountName);

    if (!creds) {
        console.error("❌ loginGps: Invalid accountName:", accountName);
        return null;
    }

    const params = {
        LoginName: creds.loginName,
        LoginPassword: creds.loginPassword,
        LoginType: GPS_LOGIN_TYPE,
        language: GPS_LANGUAGE,
        timeZone: GPS_TIMEZONE,
        apply: "APP",
        ISMD5: 0,
        loginUrl: GPS_LOGIN_URL,
    };

    try {
        console.log(
            `🔑 Logging into GPS API as account="${accountName}" (LoginName=${creds.loginName})...`
        );

        const data = await getWithParams(LOGIN_URL, params);
        console.log("📡 GPS API login response:", data);

        if (data && (data.success === "true" || data.success === true) && data.mds) {
            console.log(`✅ Login successful for account="${accountName}". Token received.`);
            return data.mds;
        }

        console.error(`❌ Login failed for account="${accountName}":`, data);
        return null;
    } catch (err) {
        console.error(`🔥 GPS Login Error (account="${accountName}"):`, err.message);
        return null;
    }
}

/**
 * Send command to GPS device (OPENRELAY / CLOSERELAY).
 * NOW USES ACCOUNT PASSWORD as the device password.
 * Returns provider raw response or null on failure.
 */
async function sendGpsCommand(macId, command, accountName, params, sendTime, token) {
    try {
        if (!token) {
            console.error("❌ No GPS token available. Aborting command.");
            return null;
        }

        // Get the account credentials to use the correct password
        const creds = getCredentialsForAccount(accountName);
        if (!creds) {
            console.error(`❌ Invalid account name: ${accountName}`);
            return null;
        }

        const requestParams = {
            method: "SendCommands",
            macid: macId,
            cmd: String(command || "").trim().toUpperCase(),
            param: params || "",
            pwd: creds.loginPassword, // ✅ Use the account's actual password
            sendTime: sendTime || nowIso(),
            mds: token,
        };

        console.log(`📡 Sending GPS command: ${requestParams.cmd} → MAC: ${macId} with account: ${accountName}`);
        console.log(`🔐 Using password from account "${accountName}"`);
        const data = await getWithParams(COMMAND_URL, requestParams);
        console.log("✅ Command provider response:", data);
        return data;
    } catch (err) {
        console.error("🔥 Error sending GPS command:", err.message);
        return null;
    }
}

/**
 * ✅ Send command WITH fallback (token refresh once on invalid token)
 * This is the safest function to call from controller.
 *
 * @param {object} opts
 * @param {string} opts.accountName "tracking" | "mobility"
 * @param {string} opts.macId
 * @param {string} opts.command "OPENRELAY" | "CLOSERELAY"
 * @param {string} [opts.params]
 * @param {string} [opts.sendTime]
 *
 * @returns {Promise<{ok:boolean, message:string|null, providerResp:any, retried:boolean}>}
 */
async function sendGpsCommandWithFallback({
                                              accountName,
                                              macId,
                                              command,
                                              params = "",
                                              sendTime = "",
                                          }) {
    const acc = normalizeAccountName(accountName);
    if (!acc) {
        return {
            ok: false,
            message: `Invalid accountName "${accountName}"`,
            providerResp: null,
            retried: false,
        };
    }

    // 1) Login first
    let token = await loginGps(acc);
    if (!token) {
        return {
            ok: false,
            message: `Login failed for account "${acc}"`,
            providerResp: null,
            retried: false,
        };
    }

    // 2) Send command (now using account password automatically)
    let providerResp = await sendGpsCommand(macId, command, acc, params, sendTime, token);

    // 3) If token invalid, refresh once and retry
    let retried = false;
    if (providerResp && isTokenInvalid(providerResp)) {
        retried = true;
        console.warn("⚠️ Token seems invalid/expired. Re-login and retry once...");

        token = await loginGps(acc);
        if (!token) {
            return {
                ok: false,
                message: `Token refresh login failed for account "${acc}"`,
                providerResp,
                retried,
            };
        }

        providerResp = await sendGpsCommand(macId, command, acc, params, sendTime, token);
    }

    const ok = isCommandOk(providerResp);
    const message = getProviderMessage(providerResp);

    return {
        ok,
        message,
        providerResp,
        retried,
    };
}

/**
 * Get realtime STATUS (NOT location) for a device by MAC.
 * Returns normalized object.
 */
async function getRealtimeStatusByMac(macId, token) {
    if (!token) {
        return { success: false, message: "Missing token" };
    }

    const commonParams = { macid: macId, mds: token, mapType: GPS_MAP_TYPE };

    // fallback methods
    const candidates = ["GetDeviceStatus", "GetNowData", "GetBitStatus"];
    let lastErr = null;

    for (const method of candidates) {
        try {
            console.log(`🔎 Fetching realtime status via method=${method} for MAC=${macId}`);
            const data = await getWithParams(COMMAND_URL, { method, ...commonParams });
            const normalized = normalizeStatusResponse(data);

            if (normalized.success) return normalized;

            lastErr = new Error(normalized.message || "Unknown provider failure");
            console.warn(`⚠️ ${method} did not return success.`, normalized);
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ ${method} call failed:`, err.message);
        }
    }

    return {
        success: false,
        message: lastErr?.message || "All status methods failed",
    };
}

/**
 * ✅ Status WITH fallback (token refresh once)
 *
 * @param {object} opts
 * @param {string} opts.accountName
 * @param {string} opts.macId
 * @returns {Promise<{success:boolean, message?:string, retried:boolean, status?:any, raw?:any}>}
 */
async function getRealtimeStatusByMacWithFallback({ accountName, macId }) {
    const acc = normalizeAccountName(accountName);
    if (!acc) return { success: false, message: `Invalid accountName "${accountName}"`, retried: false };

    let token = await loginGps(acc);
    if (!token) return { success: false, message: `Login failed for account "${acc}"`, retried: false };

    let status = await getRealtimeStatusByMac(macId, token);

    let retried = false;
    if (status && status.success === false && status.raw && isTokenInvalid(status.raw)) {
        retried = true;
        token = await loginGps(acc);
        if (!token) return { success: false, message: `Token refresh login failed for account "${acc}"`, retried };

        status = await getRealtimeStatusByMac(macId, token);
    }

    return { success: !!status?.success, message: status?.message, retried, status };
}

/**
 * Kept only for backward compatibility with controller code.
 * No caching is used, so this does nothing.
 */
function resetGpsToken() {
    console.log("ℹ️ resetGpsToken() called but token caching is disabled. No action taken.");
}

module.exports = {
    loginGps,
    sendGpsCommand,
    sendGpsCommandWithFallback,
    getRealtimeStatusByMac,
    getRealtimeStatusByMacWithFallback,
    resetGpsToken,
};