// routes/pinRoutes.js
const express = require('express');
const router = express.Router();
const pinController = require('../controllers/pinController');

/**
 * =====================================================
 * PIN MANAGEMENT ROUTES
 * =====================================================
 */

// Create or update PIN
router.post('/set', pinController.setPin);

// Verify PIN
router.post('/verify', pinController.verifyPin);

// Check if PIN exists for user
router.get('/exists/:userId', pinController.checkPinExists);

// Delete PIN (on logout)
router.delete('/delete/:userId', pinController.deletePin);

// Change PIN (requires old PIN)
router.post('/change', pinController.changePin);

module.exports = router;