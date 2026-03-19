// middleware/authMiddleware.js
const jwt  = require("jsonwebtoken");
const User = require("../models/userModel");

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
    throw new Error(
        "❌ FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must both be set in .env"
    );
}

const authMiddleware = async (req, res, next) => {
    try {
        // ── STEP 1: Extract access token from Authorization header ────────
        const authHeader = req.headers.authorization;
        const accessToken = authHeader?.split(" ")[1];

        if (!accessToken) {
            return res.status(401).json({ message: "Unauthorized: No token provided" });
        }

        try {
            // ── STEP 2: Verify access token ───────────────────────────────
            const decoded = jwt.verify(accessToken, ACCESS_SECRET);
            req.user = decoded;
            return next();

        } catch (tokenError) {
            if (tokenError.name !== 'TokenExpiredError') {
                // Malformed or wrong signature — reject immediately
                return res.status(403).json({ message: "Invalid token" });
            }

            // ── STEP 3: Access token expired — attempt auto-refresh ───────
            // Prefer httpOnly cookie (browser/web), fall back to body (Flutter/mobile)
            const refreshToken =
                req.cookies?.refreshToken ||
                req.body?.refreshToken;

            if (!refreshToken) {
                return res.status(401).json({
                    message: "Session expired. Please login again.",
                    code:    "TOKEN_EXPIRED",
                });
            }

            try {
                // ── STEP 4: Verify refresh token ──────────────────────────
                const refreshDecoded = jwt.verify(refreshToken, REFRESH_SECRET);

                // ── STEP 5: Validate against DB record ────────────────────
                const user = await User.findOne({
                    where: {
                        id:            refreshDecoded.id,
                        refresh_token: refreshToken,
                    },
                });

                if (!user) {
                    return res.status(401).json({
                        message: "Invalid session. Please login again.",
                        code:    "INVALID_REFRESH_TOKEN",
                    });
                }

                // ── STEP 6: Check DB-level expiry ─────────────────────────
                if (
                    user.refresh_token_expires_at &&
                    new Date() > new Date(user.refresh_token_expires_at)
                ) {
                    await user.update({
                        refresh_token:            null,
                        refresh_token_expires_at: null,
                    });

                    return res.status(401).json({
                        message: "Session expired. Please login again.",
                        code:    "REFRESH_TOKEN_EXPIRED",
                    });
                }

                // ── STEP 7: Issue new access token ────────────────────────
                const userType = (user.partner_id !== null && user.partner_id !== undefined)
                    ? 'chauffeur'
                    : 'regular';

                const newAccessToken = jwt.sign(
                    {
                        id:             user.id,
                        phone:          user.phone,
                        user_unique_id: user.user_unique_id,
                        user_type:      userType,
                    },
                    ACCESS_SECRET,
                    { expiresIn: "1h" }
                );

                // Deliver new token in response header so clients can update
                // their stored access token without a separate round trip
                res.setHeader('X-New-Access-Token', newAccessToken);

                req.user = {
                    id:             user.id,
                    phone:          user.phone,
                    user_unique_id: user.user_unique_id,
                    user_type:      userType,
                };

                return next();

            } catch (refreshError) {
                return res.status(401).json({
                    message: "Invalid session. Please login again.",
                    code:    "INVALID_REFRESH_TOKEN",
                });
            }
        }

    } catch (error) {
        return res.status(500).json({ message: "Authentication error" });
    }
};

module.exports = authMiddleware;