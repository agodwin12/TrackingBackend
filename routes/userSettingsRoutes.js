const express = require('express');
const router = express.Router();
const controller = require('../controllers/userSettingsController');

router.get('/:userId/settings', controller.getUserSettings);
router.put('/:userId/settings', controller.updateUserSettings);
router.put('/:userId/settings/trip-tracking', controller.updateTripTracking);

module.exports = router;