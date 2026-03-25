// routes/safeZoneRoutes.js
const express = require('express');
const router = express.Router();
const safeZoneController = require('../controllers/safeZoneController');
const authMiddleware = require('../middleware/authMiddleware');
const { requireFeature, FEATURES } = require('../middleware/subscriptionMiddleware');

// All safe zone routes require authentication + safe_zone feature.
// requireFeature is applied per-route (not via router.use) because
// vehicle_id is resolved differently per endpoint — body on POST, params on GET.
//
// NOTE: DELETE /:id intentionally has NO requireFeature.
// A DELETE request carries no body, so the middleware cannot resolve
// vehicle_id and always returns 400 "vehicle_id is required".
// Deleting a zone is a cleanup action — no subscription gate needed.
// Ownership is enforced inside deleteSafeZone via req.user.id.

router.post(
    '/',
    authMiddleware,
    requireFeature(FEATURES.SAFE_ZONE),
    safeZoneController.createSafeZone
);

router.get(
    '/',
    authMiddleware,
    requireFeature(FEATURES.SAFE_ZONE),
    safeZoneController.getAllSafeZones
);

router.get(
    '/vehicle/:vehicle_id',
    authMiddleware,
    requireFeature(FEATURES.SAFE_ZONE),
    safeZoneController.getSafeZone
);

router.put(
    '/:id',
    authMiddleware,
    requireFeature(FEATURES.SAFE_ZONE),
    safeZoneController.updateSafeZone
);

router.patch(
    '/:id/toggle',
    authMiddleware,
    requireFeature(FEATURES.SAFE_ZONE),
    safeZoneController.toggleSafeZone
);

router.delete(
    '/:id',
    authMiddleware,
    // No requireFeature — see note above
    safeZoneController.deleteSafeZone
);

module.exports = router;