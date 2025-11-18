// services/GpsService.js
const axios = require("axios");

// ==============================
// Provider endpoints / settings
// ==============================
const GPS_API_URL = "http://apitest.18gps.net/GetDateServices.asmx";
const LOGIN_URL   = `${GPS_API_URL}/loginSystem`;
const COMMAND_URL = `${GPS_API_URL}/GetDate`;

// ⚠️ Hardcoded GPS credentials (keep in env vars in prod)
const GPS_CREDENTIALS = {
    loginName: "Proxym_tracking",
    loginPassword: "proxym123",
};

// Reuse login token to avoid re-auth each call
let gpsToken = null;

// =======================================
// Helpers
// =======================================
function nowIso() {
    try {
        // Provider sometimes wants a simple “send time”; ISO is usually accepted.
        return new Date().toISOString();
    } catch {
        return "";
    }
}

/**
 * Some endpoints return boolean-looking values as strings/numbers; coerce.
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
 * Normalize “status bitfield” strings like "10100000".
 * We only care about 1st (ACC) and 3rd (oil/relay) bits per your app.
 * Returns: { accState?: boolean, oilState?: boolean }
 */
function parseStatusBits(status) {
    if (typeof status !== "string" || status.length < 3) return {};
    return {
        accState:  status[0] === "1",
        oilState:  status[2] === "1",
    };
}

/**
 * Some providers return nested shapes. This function tries to find the “data”
 * object and flatten common fields your controller expects.
 *
 * Returns normalized:
 * {
 *   success: boolean,
 *   gps_status?: "Connected" | "Disconnected" | string,
 *   speed?: number,
 *   status?: string,      // raw status bitfield if present
 *   oilState?: boolean,   // optional explicit
 *   accState?: boolean,   // optional explicit
 *   raw: any              // original payload for debugging
 * }
 */
function normalizeStatusResponse(body) {
    if (!body) return { success: false, message: "Empty response" };

    // handle shapes like { success, data: {...} } or flat {...}
    const data = body.data ?? body;

    const success =
        body.success === true ||
        body.success === "true" ||
        body.code === 0 || // some APIs use code:0 for success
        data.success === true ||
        data.success === "true";

    // Try to read fields on either level
    const gps_status =
        data.gps_status ?? data.gpsStatus ?? data.gps ?? body.gps_status ?? body.gpsStatus;

    const speed =
        data.speed ?? data.gps_speed ?? body.speed;

    const statusField =
        data.status ?? data.powerStatus ?? body.status;

    // Explicit flags if present
    const oilState =
        toBool(data.oilState ?? body.oilState);

    const accState =
        toBool(data.accState ?? body.accState);

    const normalized = {
        success: !!success,
        gps_status: gps_status ?? "Unknown",
        speed: typeof speed === "number" ? speed : Number(speed ?? 0) || 0,
        status: typeof statusField === "string" ? statusField : undefined,
        oilState,
        accState,
        raw: data,
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

    return normalized;
}

/**
 * GET wrapper with basic logging.
 */
async function getWithParams(url, params, headers = {}, timeout = 15000) {
    const res = await axios.get(url, { params, headers, timeout });
    return res.data;
}

// =======================================
// Public API
// =======================================

/**
 * Login to GPS system and retrieve token (mds).
 * Returns the token string or null.
 */
async function loginGps() {
    if (gpsToken) {
        console.log("🔑 Using existing GPS token:", gpsToken);
        return gpsToken;
    }

    const params = {
        LoginName: GPS_CREDENTIALS.loginName,
        LoginPassword: GPS_CREDENTIALS.loginPassword,
        LoginType: "ENTERPRISE",
        language: "en",
        timeZone: 8,
        apply: "APP",
        ISMD5: 0,
        loginUrl: "http://appzzl.18gps.net/",
    };

    try {
        console.log("🔑 Logging into GPS API...");
        const data = await getWithParams(LOGIN_URL, params);
        console.log("📡 GPS API login response:", data);

        if (data && (data.success === "true" || data.success === true) && data.mds) {
            gpsToken = data.mds;
            console.log("✅ Login successful. Token saved:", gpsToken);
            return gpsToken;
        }

        console.error("❌ Login failed:", data);
        return null;
    } catch (err) {
        console.error("🔥 GPS Login Error:", err.message);
        return null;
    }
}

/**
 * Send command to GPS device (OPENRELAY / CLOSERELAY).
 * Returns provider raw response or null on failure.
 */
async function sendGpsCommand(macId, command, params, password, sendTime, token) {
    try {
        if (!token) {
            console.error("❌ No GPS token available. Aborting command.");
            return null;
        }

        const requestParams = {
            method: "SendCommands",
            macid: macId,                       // device MAC
            cmd: command,                       // OPENRELAY / CLOSERELAY
            param: params || "",                // provider says empty is fine
            pwd: password || "proxym123",       // put your real device cmd password here if needed
            sendTime: sendTime || nowIso(),     // default to now
            mds: token,                         // login token
        };

        console.log(`📡 Sending GPS command: ${command} → MAC: ${macId}`);
        const data = await getWithParams(COMMAND_URL, requestParams);
        console.log("✅ Command provider response:", data);
        return data;
    } catch (err) {
        console.error("🔥 Error sending GPS command:", err.message);
        return null;
    }
}

/**
 * Get realtime STATUS (NOT location) for a device by MAC.
 * We try a primary method name; if provider differs, we try fallbacks.
 *
 * Returns normalized object (see normalizeStatusResponse).
 */
async function getRealtimeStatusByMac(macId, token) {
    if (!token) {
        return { success: false, message: "Missing token" };
    }

    const commonParams = { macid: macId, mds: token };

    // Try a list of provider method names that commonly expose status.
    // Adjust the order/names to match your provider’s docs, if you have them.
    const candidates = [
        "GetDeviceStatus",  // primary guess
        "GetNowData",       // alternative some providers use
        "GetBitStatus",     // returns the status bitfield explicitly
    ];

    let lastErr = null;

    for (const method of candidates) {
        try {
            console.log(`🔎 Fetching realtime status via method=${method} for MAC=${macId}`);
            const data = await getWithParams(COMMAND_URL, { method, ...commonParams });
            // Some providers wrap results inside { success, data: {...} }
            const normalized = normalizeStatusResponse(data);

            if (normalized.success) {
                // Ensure “gps_status” is a simple string “Connected/Disconnected” when possible
                if (normalized.gps_status === "1") normalized.gps_status = "Connected";
                if (normalized.gps_status === "0") normalized.gps_status = "Disconnected";
                return normalized;
            }

            lastErr = new Error(normalized.message || "Unknown provider failure");
            console.warn(`⚠️ ${method} did not return success.`, normalized);
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ ${method} call failed:`, err.message);
            // fallthrough to try next candidate
        }
    }

    return {
        success: false,
        message: lastErr?.message || "All status methods failed",
    };
}

// Optional: allow manual token reset (e.g., when provider invalidates mds)
function resetGpsToken() {
    gpsToken = null;
}

// =======================================
// Exports
// =======================================
module.exports = {
    loginGps,
    sendGpsCommand,
    getRealtimeStatusByMac, // ✅ the function your controller needs
    resetGpsToken,
};
