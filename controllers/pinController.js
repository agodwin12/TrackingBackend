// controllers/pinController.js
const User   = require('../models/userModel');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 10;

// PIN must be exactly 4 digits
const isValidPin = (pin) => /^\d{4}$/.test(pin);

// SHA-256 hash — used only for legacy comparison during lazy migration
const sha256 = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

// SHA-256 hashes are always 64 lowercase hex chars — bcrypt hashes start with '$2'
const isLegacyHash = (hash) => /^[a-f0-9]{64}$/.test(hash);

/**
 * Verify a PIN against the stored hash.
 * Option B lazy migration: if the stored hash is SHA-256, verify with
 * SHA-256 — on match, immediately re-hash with bcrypt and persist.
 * Returns { match: boolean, migrated: boolean }
 */
const verifyAndMigratePin = async (user, pin) => {
    const stored = user.pin_hash;

    if (isLegacyHash(stored)) {
        // Legacy SHA-256 path
        if (sha256(pin) !== stored) {
            return { match: false, migrated: false };
        }
        // Correct — upgrade to bcrypt silently
        user.pin_hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
        await user.save();
        logger.info(`🔐 PIN migrated from SHA-256 to bcrypt for user ${user.id}`);
        return { match: true, migrated: true };
    }

    // Normal bcrypt path
    const match = await bcrypt.compare(pin, stored);
    return { match, migrated: false };
};

// =====================================================
// IDOR FIX — enforce ownership on all PIN endpoints
// userId is taken from the verified JWT (req.user.id),
// never from the request body or params.
// =====================================================

// POST /api/pin/set
exports.setPin = async (req, res) => {
    try {
        const userId = req.user.id; // FIXED: from JWT, not req.body
        const { pin } = req.body;

        if (!pin) {
            return res.status(400).json({ success: false, message: 'PIN is required' });
        }

        if (!isValidPin(pin)) {
            return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Hash with bcrypt
        user.pin_hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
        await user.save();

        logger.info(`✅ PIN set for user ${userId}`);
        return res.status(200).json({ success: true, message: 'PIN created successfully' });

    } catch (error) {
        logger.error('❌ Error setting PIN:', error.message);
        return res.status(500).json({ success: false, message: 'Error setting PIN' });
    }
};

// POST /api/pin/verify
exports.verifyPin = async (req, res) => {
    try {
        const userId = req.user.id; // FIXED: from JWT, not req.body
        const { pin } = req.body;

        if (!pin) {
            return res.status(400).json({ success: false, message: 'PIN is required' });
        }

        if (!isValidPin(pin)) {
            return res.status(400).json({ success: false, message: 'Invalid PIN format' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.pin_hash) {
            return res.status(404).json({ success: false, message: 'No PIN set for this user' });
        }

        const { match } = await verifyAndMigratePin(user, pin);

        if (match) {
            logger.info(`✅ PIN verified for user ${userId}`);
            return res.status(200).json({ success: true, message: 'PIN is correct' });
        }

        logger.warn(`❌ Wrong PIN attempt for user ${userId}`);
        return res.status(401).json({ success: false, message: 'Incorrect PIN' });

    } catch (error) {
        logger.error('❌ Error verifying PIN:', error.message);
        return res.status(500).json({ success: false, message: 'Error verifying PIN' });
    }
};

// GET /api/pin/exists
exports.checkPinExists = async (req, res) => {
    try {
        const userId = req.user.id; // FIXED: from JWT, not req.params

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const raw        = user.pin_hash;
        const normalized = (raw ?? '').toString().trim().toLowerCase();
        const hasPinSet  =
            normalized.length > 0 &&
            normalized !== 'null' &&
            normalized !== 'undefined';

        // FIXED: removed pinHashPreview debug field — leaks internal hash format
        return res.status(200).json({ success: true, hasPinSet });

    } catch (error) {
        logger.error('❌ Error checking PIN existence:', error.message);
        return res.status(500).json({ success: false, message: 'Error checking PIN' });
    }
};

// DELETE /api/pin/delete
exports.deletePin = async (req, res) => {
    try {
        const userId = req.user.id; // FIXED: from JWT, not req.params

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        user.pin_hash = null;
        await user.save();

        logger.info(`✅ PIN deleted for user ${userId}`);
        return res.status(200).json({ success: true, message: 'PIN deleted successfully' });

    } catch (error) {
        logger.error('❌ Error deleting PIN:', error.message);
        return res.status(500).json({ success: false, message: 'Error deleting PIN' });
    }
};

// POST /api/pin/change
exports.changePin = async (req, res) => {
    try {
        const userId           = req.user.id; // FIXED: from JWT, not req.body
        const { oldPin, newPin } = req.body;

        if (!oldPin || !newPin) {
            return res.status(400).json({ success: false, message: 'Old PIN and new PIN are required' });
        }

        if (!isValidPin(oldPin) || !isValidPin(newPin)) {
            return res.status(400).json({ success: false, message: 'PINs must be exactly 4 digits' });
        }

        if (oldPin === newPin) {
            return res.status(400).json({ success: false, message: 'New PIN must differ from old PIN' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify old PIN (handles legacy SHA-256 migration too)
        const { match } = await verifyAndMigratePin(user, oldPin);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Old PIN is incorrect' });
        }

        // Hash new PIN with bcrypt
        user.pin_hash = await bcrypt.hash(newPin, BCRYPT_ROUNDS);
        await user.save();

        logger.info(`✅ PIN changed for user ${userId}`);
        return res.status(200).json({ success: true, message: 'PIN changed successfully' });

    } catch (error) {
        logger.error('❌ Error changing PIN:', error.message);
        return res.status(500).json({ success: false, message: 'Error changing PIN' });
    }
};