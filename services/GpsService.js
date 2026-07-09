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
        loginName: process.env.GPS_LOGIN_NAME_1,
        loginPassword: process.env.GPS_LOGIN_PASSWORD_1,
    },
    mobility: {
        loginName: process.env.GPS_LOGIN_NAME_2,
        loginPassword: process.env.GPS_LOGIN_PASSWORD_2,
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
 * Parse the 8-character status bitfield from 18gps API.
 *
 * Per API docs (Interface 9 / 15):
 *   status[0] → ACC state        (1=on,  0=off)
 *   status[1] → Device defense   (1=armed, 0=disarmed)
 *   status[2] → Oil/electricity  (1=on,  0=CUT — relay open)
 *   status[3] → Charging state
 *   status[4] → Door state       (1=open, 0=closed)
 *   status[5] → GPS positioning  (1=yes, 0=no)
 *   status[6] → Main power       (1=present, 0=absent)
 *   status[7] → Platform defense
 */
function parseStatusBits(status) {
    if (typeof status !== "string" || status.length < 3) return {};
    return {
        accState: status[0] === "1",   // ACC / ignition
        oilState: status[2] === "1",   // relay: 1=connected, 0=cut
    };
}

/**
 * ── KEY MAP from 18gps API docs (Interface 9 & 15) ──────────────────────────
 * records[N] is an array. Each index maps to:
 *   0  → sys_time      (UTC ms timestamp of GPS fix)
 *   1  → user_name     (device name)
 *   2  → jingdu        (longitude)
 *   3  → weidu         (latitude)
 *   4  → ljingdu       (corrected longitude — same as [2] for WGS84)
 *   5  → lweidu        (corrected latitude  — same as [3] for WGS84)
 *   6  → datetime      (server receive time ms)
 *   7  → heart_time    (device heartbeat time ms)
 *   8  → su            (speed; "-9" = device disabled)
 *   9  → status        (8-char bitfield — see parseStatusBits above)
 *  10  → hangxiang     (direction/heading degrees)
 *  11  → sim_id        (IMEI / device number)
 *  12  → user_id       (18gps device Guid)
 *  15  → server_time   (current server time ms — used for online check)
 *  19  → statenumber   (16-value csv: mileage, oil, weight, temp, battery…)
 *
 * Online check (per docs): (server_time - heart_time) < 25 minutes = online
 * Disabled check:          speed === "-9" AND offline > 25 min
 * ─────────────────────────────────────────────────────────────────────────────
 */
const RECORD_KEY = {
    SYS_TIME:    0,
    USER_NAME:   1,
    LONGITUDE:   2,
    LATITUDE:    3,
    DATETIME:    6,
    HEART_TIME:  7,
    SPEED:       8,
    STATUS:      9,
    DIRECTION:   10,
    SIM_ID:      11,
    USER_ID:     12,
    SERVER_TIME: 15,
    STATENUMBER: 19,
};

/**
 * Parse a single records[] entry from the 18gps API into a normalized status
 * object that matches the shape the controller already expects.
 *
 * @param {Array} record  — one element of data[0].records
 * @returns {{
 *   success: true,
 *   gps_status: string,
 *   speed: number,
 *   status: string,
 *   oilState: boolean,
 *   accState: boolean,
 *   latitude: number,
 *   longitude: number,
 *   direction: number,
 *   isOnline: boolean,
 *   isDisabled: boolean,
 *   raw: Array
 * }}
 */
function parseRecord(record) {
    const statusStr  = String(record[RECORD_KEY.STATUS] || "");
    const speedRaw   = record[RECORD_KEY.SPEED];
    const speed      = Number(speedRaw) || 0;
    const heartTime  = Number(record[RECORD_KEY.HEART_TIME]) || 0;
    const serverTime = Number(record[RECORD_KEY.SERVER_TIME]) || Date.now();

    const offlineMs   = serverTime - heartTime;
    const isOnline    = offlineMs < 25 * 60 * 1000; // < 25 minutes
    const isDisabled  = String(speedRaw) === "-9" && !isOnline;

    const bits = parseStatusBits(statusStr);

    return {
        success:    true,
        gps_status: isOnline ? "Connected" : "Disconnected",
        speed,
        status:     statusStr,
        oilState:   bits.oilState  ?? false,
        accState:   bits.accState  ?? false,
        latitude:   Number(record[RECORD_KEY.LATITUDE])  || 0,
        longitude:  Number(record[RECORD_KEY.LONGITUDE]) || 0,
        direction:  Number(record[RECORD_KEY.DIRECTION]) || 0,
        isOnline,
        isDisabled,
        raw: record,
    };
}

/**
 * Normalize "status bitfield" strings like "10100000".
 * We only care about 1st (ACC) and 3rd (oil/relay) bits per your app.
 * Returns: { accState?: boolean, oilState?: boolean }
 * Kept for backward compatibility with any other callers.
 */
function normalizeStatusResponse(body) {
    if (!body) return { success: false, message: "Empty response" };

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

    if (normalized.status && (oilState === undefined || accState === undefined)) {
        const bits = parseStatusBits(normalized.status);
        if (normalized.oilState === undefined && bits.oilState !== undefined) {
            normalized.oilState = bits.oilState;
        }
        if (normalized.accState === undefined && bits.accState !== undefined) {
            normalized.accState = bits.accState;
        }
    }

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
 * NO CACHING: always returns a fresh token + unitId.
 *
 * @param {string} accountName "tracking" | "mobility"
 * @returns {Promise<{token: string, unitId: string}|null>}
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
            // ── CHANGED: also return unitId (data.id) — needed for getDeviceListByCustomId fallback ──
            return { token: data.mds, unitId: data.id || null };
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
 * Returns provider raw response or null on failure.
 */
async function sendGpsCommand(macId, command, accountName, params, sendTime, token) {
    try {
        if (!token) {
            console.error("❌ No GPS token available. Aborting command.");
            return null;
        }

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
            pwd: creds.loginPassword,
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

    const loginResult = await loginGps(acc);
    if (!loginResult) {
        return {
            ok: false,
            message: `Login failed for account "${acc}"`,
            providerResp: null,
            retried: false,
        };
    }

    let { token } = loginResult;

    let providerResp = await sendGpsCommand(macId, command, acc, params, sendTime, token);

    let retried = false;
    if (providerResp && isTokenInvalid(providerResp)) {
        retried = true;
        console.warn("⚠️ Token seems invalid/expired. Re-login and retry once...");

        const retryLogin = await loginGps(acc);
        if (!retryLogin) {
            return {
                ok: false,
                message: `Token refresh login failed for account "${acc}"`,
                providerResp,
                retried,
            };
        }

        token = retryLogin.token;
        providerResp = await sendGpsCommand(macId, command, acc, params, sendTime, token);
    }

    const ok = isCommandOk(providerResp);
    const message = getProviderMessage(providerResp);

    return { ok, message, providerResp, retried };
}

/**
 * ── CHANGED ──────────────────────────────────────────────────────────────────
 * Get realtime status for a device using the correct 18gps API endpoints.
 *
 * Strategy:
 *   1. PRIMARY:  getUserAndGpsInfoByIDsUtcNew  — single device by 18gps user_id (Guid)
 *                Requires gpsUserId (sim_gps.objectid).
 *   2. FALLBACK: getDeviceListByCustomId       — all devices under the unit account
 *                Requires unitId from login response. Filters by macId in the result.
 *
 * Both return records[] arrays parsed with parseRecord() using the documented key map.
 *
 * @param {string}      macId      — IMEI / mac_id_gps
 * @param {string}      token      — 18gps mds token
 * @param {string|null} gpsUserId  — sim_gps.objectid (18gps device Guid), may be null
 * @param {string|null} unitId     — unit id from loginGps() response, used as fallback
 */
async function getRealtimeStatusByMac(macId, token, gpsUserId = null, unitId = null) {
    if (!token) {
        return { success: false, message: "Missing token" };
    }

    // ── PRIMARY: getUserAndGpsInfoByIDsUtcNew ─────────────────────────────────
    if (gpsUserId) {
        try {
            console.log(`🔎 [PRIMARY] getUserAndGpsInfoByIDsUtcNew → MAC=${macId} gpsUserId=${gpsUserId}`);

            const data = await getWithParams(COMMAND_URL, {
                method:  "getUserAndGpsInfoByIDsUtcNew",
                user_id: gpsUserId,
                mapType: GPS_MAP_TYPE,
                option:  GPS_LANGUAGE,
                mds:     token,
            });

            console.log("📡 getUserAndGpsInfoByIDsUtcNew response:", JSON.stringify(data).slice(0, 300));

            if (
                data &&
                (data.success === "true" || data.success === true) &&
                Array.isArray(data.data) &&
                data.data.length > 0
            ) {
                const deviceBlock = data.data[0];
                const records = deviceBlock.records;

                if (Array.isArray(records) && records.length > 0) {
                    const parsed = parseRecord(records[0]);
                    console.log(`✅ [PRIMARY] Status parsed — oilState=${parsed.oilState} accState=${parsed.accState} speed=${parsed.speed}`);
                    return parsed;
                }
            }

            console.warn("⚠️ [PRIMARY] No records in response, falling through to fallback");
        } catch (err) {
            console.warn(`⚠️ [PRIMARY] getUserAndGpsInfoByIDsUtcNew failed: ${err.message}`);
        }
    } else {
        console.warn(`⚠️ [PRIMARY] gpsUserId not available for MAC=${macId}, skipping primary method`);
    }

    // ── FALLBACK: getDeviceListByCustomId ─────────────────────────────────────
    if (unitId) {
        try {
            console.log(`🔎 [FALLBACK] getDeviceListByCustomId → unitId=${unitId} looking for MAC=${macId}`);

            const data = await getWithParams(COMMAND_URL, {
                method:  "getDeviceListByCustomId",
                id:      unitId,
                mapType: GPS_MAP_TYPE,
                mds:     token,
            });

            console.log("📡 getDeviceListByCustomId response:", JSON.stringify(data).slice(0, 300));

            if (
                data &&
                (data.success === "true" || data.success === true) &&
                Array.isArray(data.data) &&
                data.data.length > 0
            ) {
                const deviceBlock = data.data[0];
                const records = deviceBlock.records;

                if (Array.isArray(records) && records.length > 0) {
                    // Filter to find the specific MAC in the list
                    const match = records.find(
                        (r) => String(r[RECORD_KEY.SIM_ID] || "").trim() === String(macId).trim()
                    );

                    if (match) {
                        const parsed = parseRecord(match);
                        console.log(`✅ [FALLBACK] Status parsed — oilState=${parsed.oilState} accState=${parsed.accState} speed=${parsed.speed}`);
                        return parsed;
                    }

                    console.warn(`⚠️ [FALLBACK] MAC=${macId} not found in device list of ${records.length} records`);
                }
            }

            console.warn("⚠️ [FALLBACK] No usable data in getDeviceListByCustomId response");
        } catch (err) {
            console.warn(`⚠️ [FALLBACK] getDeviceListByCustomId failed: ${err.message}`);
        }
    } else {
        console.warn(`⚠️ [FALLBACK] unitId not available, cannot use getDeviceListByCustomId`);
    }

    return {
        success: false,
        message: "All status methods failed — check gpsUserId (sim_gps.objectid) and unitId from login",
    };
}

/**
 * ── CHANGED ──────────────────────────────────────────────────────────────────
 * Status WITH fallback (token refresh once).
 * Now looks up sim_gps.objectid to pass as gpsUserId to getRealtimeStatusByMac.
 * Controller signature unchanged: { accountName, macId }
 *
 * @param {object} opts
 * @param {string} opts.accountName
 * @param {string} opts.macId
 * @returns {Promise<{success:boolean, message?:string, retried:boolean, status?:any}>}
 */
async function getRealtimeStatusByMacWithFallback({ accountName, macId }) {
    const acc = normalizeAccountName(accountName);
    if (!acc) return { success: false, message: `Invalid accountName "${accountName}"`, retried: false };

    // ── Look up gpsUserId from sim_gps.objectid ───────────────────────────────
    // We import SimGps here (lazy require) to avoid circular dependency issues.
    let gpsUserId = null;
    try {
        const SimGps = require("../models/sim_gps");
        const simRecord = await SimGps.findOne({
            where: { mac_id: macId },
            attributes: ["objectid"],
            order: [["updated_at", "DESC"]],
        });
        gpsUserId = simRecord?.objectid || null;
        if (gpsUserId) {
            console.log(`✅ Found gpsUserId=${gpsUserId} for MAC=${macId}`);
        } else {
            console.warn(`⚠️ sim_gps.objectid is null for MAC=${macId} — will use fallback method`);
        }
    } catch (err) {
        console.warn(`⚠️ Could not look up sim_gps.objectid: ${err.message}`);
    }

    // ── Login ─────────────────────────────────────────────────────────────────
    let loginResult = await loginGps(acc);
    if (!loginResult) return { success: false, message: `Login failed for account "${acc}"`, retried: false };

    let { token, unitId } = loginResult;

    // ── First attempt ─────────────────────────────────────────────────────────
    let status = await getRealtimeStatusByMac(macId, token, gpsUserId, unitId);

    // ── Token refresh + retry if needed ──────────────────────────────────────
    let retried = false;
    if (!status?.success && status?.raw && isTokenInvalid(status.raw)) {
        retried = true;
        console.warn("⚠️ Token invalid. Re-login and retry once...");

        loginResult = await loginGps(acc);
        if (!loginResult) return { success: false, message: `Token refresh login failed for account "${acc}"`, retried };

        token  = loginResult.token;
        unitId = loginResult.unitId;

        status = await getRealtimeStatusByMac(macId, token, gpsUserId, unitId);
    }

    return { success: !!status?.success, message: status?.message, retried, status };
}

/**
 * Kept for backward compatibility.
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