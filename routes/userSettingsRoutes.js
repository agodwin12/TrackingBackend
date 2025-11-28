const express = require('express');
const router = express.Router();
const controller = require('../controllers/userSettingsController');

// Get user's current settings
router.get('/:userId/settings', controller.getUserSettings);

// Update all settings at once
router.put('/:userId/settings', controller.updateUserSettings);

// Update trip tracking setting only
router.put('/:userId/settings/trip-tracking', controller.updateTripTracking);

// Update alert settings (geofence and safe zone)
router.put('/:userId/settings/alerts', controller.updateAlertSettings);

module.exports = router;