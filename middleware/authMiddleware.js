// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

const authMiddleware = async (req, res, next) => {
    try {
        // ✅ STEP 1: Extract access token from Authorization header
        const authHeader = req.headers.authorization;
        const accessToken = authHeader?.split(" ")[1];

        if (!accessToken) {
            console.log("❌ No access token provided");
            return res.status(401).json({ message: "Unauthorized: No token provided" });
        }

        try {
            // ✅ STEP 2: Try to verify access token
            const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);
            req.user = decoded;

            console.log(`✅ Valid access token for user ${decoded.id}`);
            return next();

        } catch (tokenError) {
            // ✅ STEP 3: Access token is expired or invalid
            if (tokenError.name === 'TokenExpiredError') {
                console.log("⏰ Access token expired, attempting auto-refresh...");

                // ✅ STEP 4: Check for refresh token in cookie
                const refreshToken = req.cookies?.refreshToken;

                if (!refreshToken) {
                    console.log("❌ No refresh token found in cookies");
                    return res.status(401).json({
                        message: "Session expired. Please login again.",
                        code: "TOKEN_EXPIRED"
                    });
                }

                try {
                    // ✅ STEP 5: Verify refresh token
                    const refreshDecoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

                    // ✅ STEP 6: Check if refresh token exists in database
                    const user = await User.findOne({
                        where: {
                            id: refreshDecoded.id,
                            refresh_token: refreshToken
                        }
                    });

                    if (!user) {
                        console.log("❌ Refresh token not found in database or user deleted");
                        return res.status(401).json({
                            message: "Invalid session. Please login again.",
                            code: "INVALID_REFRESH_TOKEN"
                        });
                    }

                    // ✅ STEP 7: Check if refresh token is expired in database
                    if (user.refresh_token_expires_at && new Date() > new Date(user.refresh_token_expires_at)) {
                        console.log("❌ Refresh token expired in database");

                        // Clear expired refresh token
                        await user.update({
                            refresh_token: null,
                            refresh_token_expires_at: null
                        });

                        return res.status(401).json({
                            message: "Session expired. Please login again.",
                            code: "REFRESH_TOKEN_EXPIRED"
                        });
                    }

                    // ✅ STEP 8: Generate new access token (90 days)
                    const newAccessToken = jwt.sign(
                        {
                            id: user.id,
                            phone: user.phone,
                            user_unique_id: user.user_unique_id
                        },
                        process.env.JWT_SECRET,
                        { expiresIn: "90d" }  // ✅ Changed from 1h to 90d
                    );

                    console.log(`✅ Generated new access token for user ${user.id}`);

                    // ✅ STEP 9: Attach new token to response header (frontend will update automatically)
                    res.setHeader('X-New-Access-Token', newAccessToken);

                    // ✅ STEP 10: Set user in request and continue
                    req.user = {
                        id: user.id,
                        phone: user.phone,
                        user_unique_id: user.user_unique_id
                    };

                    console.log(`🔄 Token auto-refreshed for user ${user.id}`);
                    return next();

                } catch (refreshError) {
                    console.log("❌ Invalid refresh token:", refreshError.message);
                    return res.status(401).json({
                        message: "Invalid session. Please login again.",
                        code: "INVALID_REFRESH_TOKEN"
                    });
                }
            } else {
                // Invalid token (not expired, but malformed or wrong signature)
                console.log("❌ Invalid access token:", tokenError.message);
                return res.status(403).json({ message: "Invalid token" });
            }
        }

    } catch (error) {
        console.error("🔥 Auth middleware error:", error);
        return res.status(500).json({ message: "Authentication error" });
    }
};

module.exports = authMiddleware;