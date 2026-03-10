// controllers/pinController.js
const User = require('../models/userModel');
const crypto = require('crypto');

/**
 * Hash PIN using SHA-256
 */
const hashPin = (pin) => {
    return crypto.createHash('sha256').update(pin).digest('hex');
};

/**
 * Validate PIN format (must be exactly 4 digits)
 */
const isValidPin = (pin) => {
    return /^\d{4}$/.test(pin);
};

/**
 * =====================================================
 * CREATE OR UPDATE PIN
 * POST /api/pin/set
 * Body: { userId, pin }
 * =====================================================
 */
exports.setPin = async (req, res) => {
    try {
        const { userId, pin } = req.body;

        // Validate inputs
        if (!userId || !pin) {
            return res.status(400).json({
                success: false,
                message: 'User ID and PIN are required'
            });
        }

        // Validate PIN format
        if (!isValidPin(pin)) {
            return res.status(400).json({
                success: false,
                message: 'PIN must be exactly 4 digits'
            });
        }

        // Find user
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Hash and save PIN
        const pinHash = hashPin(pin);
        user.pin_hash = pinHash;
        await user.save();

        console.log(`✅ PIN set for user ${userId}`);

        return res.status(200).json({
            success: true,
            message: 'PIN created successfully'
        });

    } catch (error) {
        console.error('❌ Error setting PIN:', error);
        return res.status(500).json({
            success: false,
            message: 'Error setting PIN',
            error: error.message
        });
    }
};

/**
 * =====================================================
 * VERIFY PIN
 * POST /api/pin/verify
 * Body: { userId, pin }
 * =====================================================
 */
exports.verifyPin = async (req, res) => {
    try {
        const { userId, pin } = req.body;

        // Validate inputs
        if (!userId || !pin) {
            return res.status(400).json({
                success: false,
                message: 'User ID and PIN are required'
            });
        }

        // Validate PIN format
        if (!isValidPin(pin)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid PIN format'
            });
        }

        // Find user
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check if PIN is set
        if (!user.pin_hash) {
            return res.status(404).json({
                success: false,
                message: 'No PIN set for this user'
            });
        }

        // Verify PIN
        const pinHash = hashPin(pin);
        const isCorrect = pinHash === user.pin_hash;

        if (isCorrect) {
            console.log(`✅ PIN verified for user ${userId}`);
            return res.status(200).json({
                success: true,
                message: 'PIN is correct'
            });
        } else {
            console.log(`❌ Wrong PIN for user ${userId}`);
            return res.status(401).json({
                success: false,
                message: 'Incorrect PIN'
            });
        }

    } catch (error) {
        console.error('❌ Error verifying PIN:', error);
        return res.status(500).json({
            success: false,
            message: 'Error verifying PIN',
            error: error.message
        });
    }
};

/**
 * =====================================================
 * CHECK IF PIN EXISTS
 * GET /api/pin/exists/:userId
 * =====================================================
 */
exports.checkPinExists = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID is required' });
        }

        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const raw = user.pin_hash; // can be null / '' / 'null' / '   '
        const normalized = (raw ?? '').toString().trim().toLowerCase();

        const hasPinSet =
            normalized.length > 0 &&
            normalized !== 'null' &&
            normalized !== 'undefined';

        return res.status(200).json({
            success: true,
            userId: user.id,
            pinHashPreview: raw ? raw.substring(0, 8) + '...' : null, // debug
            hasPinSet,
        });
    } catch (error) {
        console.error('❌ Error checking PIN existence:', error);
        return res.status(500).json({
            success: false,
            message: 'Error checking PIN',
            error: error.message,
        });
    }
};
/**
 * =====================================================
 * DELETE PIN
 * DELETE /api/pin/delete/:userId
 * (Called on logout)
 * =====================================================
 */
exports.deletePin = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        // Find user
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Delete PIN
        user.pin_hash = null;
        await user.save();

        console.log(`✅ PIN deleted for user ${userId}`);

        return res.status(200).json({
            success: true,
            message: 'PIN deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting PIN:', error);
        return res.status(500).json({
            success: false,
            message: 'Error deleting PIN',
            error: error.message
        });
    }
};

/**
 * =====================================================
 * CHANGE PIN
 * POST /api/pin/change
 * Body: { userId, oldPin, newPin }
 * =====================================================
 */
exports.changePin = async (req, res) => {
    try {
        const { userId, oldPin, newPin } = req.body;

        // Validate inputs
        if (!userId || !oldPin || !newPin) {
            return res.status(400).json({
                success: false,
                message: 'User ID, old PIN, and new PIN are required'
            });
        }

        // Validate PIN formats
        if (!isValidPin(oldPin) || !isValidPin(newPin)) {
            return res.status(400).json({
                success: false,
                message: 'PINs must be exactly 4 digits'
            });
        }

        // Find user
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Verify old PIN
        const oldPinHash = hashPin(oldPin);
        if (oldPinHash !== user.pin_hash) {
            return res.status(401).json({
                success: false,
                message: 'Old PIN is incorrect'
            });
        }

        // Set new PIN
        const newPinHash = hashPin(newPin);
        user.pin_hash = newPinHash;
        await user.save();

        console.log(`✅ PIN changed for user ${userId}`);

        return res.status(200).json({
            success: true,
            message: 'PIN changed successfully'
        });

    } catch (error) {
        console.error('❌ Error changing PIN:', error);
        return res.status(500).json({
            success: false,
            message: 'Error changing PIN',
            error: error.message
        });
    }
};