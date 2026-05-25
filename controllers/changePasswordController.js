// controllers/changePasswordController.js
const bcrypt          = require('bcryptjs');
const User            = require('../models/userModel');
const AssociationUserVoiture = require('../models/AssociationUserVoiture');
const keycloakService = require('../services/keycloakService');
const logger          = require('../utils/logger');

// ─── Helper: sync password to Keycloak (non-blocking on failure) ──────────────
async function syncKeycloakPassword(user, newPassword) {
    if (!user.keycloak_id) {
        logger.warn(`⚠️ [ChangePassword] User ${user.id} has no keycloak_id — skipping Keycloak sync`);
        return;
    }
    try {
        await keycloakService.resetKeycloakPassword(user.keycloak_id, newPassword);
        logger.info(`✅ [ChangePassword] Keycloak password synced for user ${user.id}`);
    } catch (err) {
        logger.error(`❌ [ChangePassword] Keycloak sync failed for user ${user.id}: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change password by vehicle ID
// POST /api/password/users/change-password
// ─────────────────────────────────────────────────────────────────────────────
exports.changePasswordByVehicleId = async (req, res) => {
    try {
        const { vehicleId, old_password, new_password } = req.body;

        if (!vehicleId || !old_password || !new_password) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const association = await AssociationUserVoiture.findOne({
            where: { voiture_id: vehicleId },
            attributes: ['user_id'],
        });

        if (!association) {
            return res.status(404).json({ success: false, message: 'No user associated with this vehicle.' });
        }

        const user = await User.findOne({ where: { id: association.user_id } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(old_password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Incorrect old password' });
        }

        const hashedPassword = await bcrypt.hash(new_password, 10);
        await user.update({ password: hashedPassword });
        logger.info(`✅ [ChangePassword] MySQL password updated for user ${user.id}`);

        await syncKeycloakPassword(user, new_password);

        return res.json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
        logger.error('🔥 [ChangePassword] changePasswordByVehicleId error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Set password on first login
// POST /api/users/set-password-first-login
// ─────────────────────────────────────────────────────────────────────────────
exports.setPasswordFirstLogin = async (req, res) => {
    try {
        const { userId, newPassword } = req.body;

        if (!userId || !newPassword) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        const user = await User.findOne({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await user.update({ password: hashedPassword, is_first_login: false });
        logger.info(`✅ [ChangePassword] First-login password set for user ${user.id}`);

        await syncKeycloakPassword(user, newPassword);

        return res.json({ success: true, message: 'Password set successfully' });

    } catch (error) {
        logger.error('🔥 [ChangePassword] setPasswordFirstLogin error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Set password (generic)
// POST /api/users/set-password
// ─────────────────────────────────────────────────────────────────────────────
exports.setPassword = async (req, res) => {
    try {
        const { userId, newPassword } = req.body;

        if (!userId || !newPassword) {
            return res.status(400).json({ success: false, message: 'User ID and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await user.update({ password: hashedPassword, is_first_login: false });
        logger.info(`✅ [ChangePassword] Password set for user ${user.id}`);

        await syncKeycloakPassword(user, newPassword);

        return res.json({
            success: true,
            message: 'Password set successfully',
            data: { userId: user.id, email: user.email },
        });

    } catch (error) {
        logger.error('🔥 [ChangePassword] setPassword error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Change password for recouvrement/partner users
// PUT /api/partner/change-password
// Requires Keycloak authMiddleware — req.user has id + keycloak_id
// ─────────────────────────────────────────────────────────────────────────────
exports.changePasswordPartner = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId     = req.user?.id;
        const keycloakId = req.user?.keycloak_id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }
        if (currentPassword === newPassword) {
            return res.status(400).json({ success: false, message: 'New password must be different from current password' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect' });
        }

        // Update MySQL
        const hashed = await bcrypt.hash(newPassword, 10);
        await user.update({ password: hashed });
        logger.info(`✅ [ChangePassword] MySQL updated for partner user ${userId}`);

        // Sync to Keycloak — this is the primary auth for recouvrement users
        try {
            await keycloakService.resetKeycloakPassword(keycloakId, newPassword);
            logger.info(`✅ [ChangePassword] Keycloak synced for partner user ${userId}`);
        } catch (err) {
            // Log but don't fail — MySQL already updated
            logger.error(`❌ [ChangePassword] Keycloak sync failed for partner user ${userId}: ${err.message}`);
        }

        return res.json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
        logger.error('🔥 [ChangePassword] changePasswordPartner error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Logout for recouvrement/partner users
// POST /api/partner/logout
// Revokes Keycloak session then returns success
// Flutter clears SharedPreferences client-side
// ─────────────────────────────────────────────────────────────────────────────
exports.logoutPartner = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        const appClient = req.user?.app_client || 'recouvrement_app';

        if (!refreshToken) {
            return res.status(400).json({ success: false, message: 'refreshToken is required' });
        }

        // Revoke Keycloak session — non-blocking on failure
        try {
            await keycloakService.logout(refreshToken, appClient);
            logger.info(`✅ [Logout] Keycloak session revoked for user ${req.user?.id}`);
        } catch (err) {
            // Don't block — client must still clear local state
            logger.warn(`⚠️ [Logout] Keycloak revocation failed (non-fatal): ${err.message}`);
        }

        return res.json({ success: true, message: 'Logged out successfully' });

    } catch (error) {
        logger.error('🔥 [Logout] logoutPartner error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};