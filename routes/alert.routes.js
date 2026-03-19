// routes/alert.routes.js
const express = require("express");
const router = express.Router();
const alertController = require("../controllers/alertController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

// ── Alert reading — live tracking feature ────────────────────────────────────

router.get(
    "/vehicle/:vehicleId",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    alertController.getAlertsByVehicle
);

router.patch(
    "/:id/read",
    authMiddleware,
    alertController.markAlertAsRead   // no vehicle_id on this route — skip feature gate
);

router.patch(
    "/vehicle/:vehicleId/read-all",
    authMiddleware,
    requireFeature(FEATURES.LIVE_TRACKING),
    alertController.markAllAsRead
);

// ── Stolen vehicle — report_stolen feature ───────────────────────────────────

router.post(
    '/report-stolen',
    authMiddleware,
    requireFeature(FEATURES.REPORT_STOLEN),
    alertController.reportStolenVehicle
);

router.get(
    '/vehicle/:vehicleId/stolen',
    authMiddleware,
    requireFeature(FEATURES.REPORT_STOLEN),
    alertController.getActiveStolenAlert
);

router.patch(
    '/:id/resolve',
    authMiddleware,
    alertController.resolveStolenAlert  // no vehicle_id on this route — skip feature gate
);

module.exports = router;