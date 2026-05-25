// middleware/authMiddleware.js
const jwt  = require('jsonwebtoken');
const User = require('../models/userModel');
const logger = require('../utils/logger');

const JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const authMiddleware = async (req, res, next) => {
    try {
        // STEP 1: Extract access token from Authorization header
        const authHeader = req.headers.authorization;
        const accessToken = authHeader?.split(' ')[1];

        if (!accessToken) {
            logger.warn('❌ No access token provided');
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        try {
            // STEP 2: Verify access token
            const decoded = jwt.verify(accessToken, JWT_ACCESS_SECRET);
            req.user = decoded;
            logger.info(`✅ Valid access token for user ${decoded.id}`);
            return next();

        } catch (tokenError) {

            // STEP 3: Access token expired → try refresh cookie
            if (tokenError.name === 'TokenExpiredError') {
                logger.info('⏰ Access token expired, attempting auto-refresh...');

                const refreshToken = req.cookies?.refreshToken;

                if (!refreshToken) {
                    logger.warn('❌ No refresh token found in cookies');
                    return res.status(401).json({
                        message: 'Session expired. Please login again.',
                        code: 'TOKEN_EXPIRED',
                    });
                }

                try {
                    // STEP 4: Verify refresh token
                    const refreshDecoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

                    // STEP 5: Confirm refresh token still exists in DB
                    const user = await User.findOne({
                        where: { id: refreshDecoded.id, refresh_token: refreshToken },
                    });

                    if (!user) {
                        logger.warn('❌ Refresh token not found in DB or user deleted');
                        return res.status(401).json({
                            message: 'Invalid session. Please login again.',
                            code: 'INVALID_REFRESH_TOKEN',
                        });
                    }

                    // STEP 6: Check DB-level expiry
                    if (user.refresh_token_expires_at && new Date() > new Date(user.refresh_token_expires_at)) {
                        logger.warn('❌ Refresh token expired in DB');
                        await user.update({ refresh_token: null, refresh_token_expires_at: null });
                        return res.status(401).json({
                            message: 'Session expired. Please login again.',
                            code: 'REFRESH_TOKEN_EXPIRED',
                        });
                    }

                    // STEP 7: Issue new access token
                    const isChauffeur = user.partner_id !== null && user.partner_id !== undefined;
                    const app_type    = user.type_partner === 'LEASE_PARTNER' ? 'recouvrement' : 'tracking';

                    const newAccessToken = jwt.sign(
                        {
                            id:             user.id,
                            phone:          user.phone,
                            user_unique_id: user.user_unique_id,
                            user_type:      isChauffeur ? 'chauffeur' : 'regular',
                            app_type,
                        },
                        JWT_ACCESS_SECRET,
                        { expiresIn: '90d' }
                    );

                    // Return new token in header so Flutter can persist it
                    res.setHeader('X-New-Access-Token', newAccessToken);

                    req.user = {
                        id:             user.id,
                        phone:          user.phone,
                        user_unique_id: user.user_unique_id,
                        user_type:      isChauffeur ? 'chauffeur' : 'regular',
                        app_type,
                    };

                    logger.info(`🔄 Token auto-refreshed for user ${user.id} | app_type=${app_type}`);
                    return next();

                } catch (refreshError) {
                    logger.warn('❌ Refresh token verification failed:', refreshError.message);
                    return res.status(401).json({
                        message: 'Invalid session. Please login again.',
                        code: 'INVALID_REFRESH_TOKEN',
                    });
                }

            } else {
                // Malformed or wrong-signature token
                logger.warn('❌ Invalid access token:', tokenError.message);
                return res.status(401).json({ message: 'Invalid token' });
            }
        }

    } catch (error) {
        logger.error('🔥 Auth middleware error:', error);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = authMiddleware;