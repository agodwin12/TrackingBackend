// routes/tripRoutes.js
const express = require("express");
const router = express.Router();
const tripController = require("../controllers/tripController");
const TripDetectionCron = require("../jobs/tripDetectionCron");
const authMiddleware = require("../middleware/authMiddleware");
const { requireFeature, FEATURES } = require("../middleware/subscriptionMiddleware");

// ========================================
// SPECIFIC ROUTES FIRST (before parameters)
// ========================================

// All trips — vehicle_id comes from query string (?vehicleId=X), gated per-request
router.get(
    "/trips",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getAllTrips
);

// Trips for a specific vehicle
router.get(
    "/trips/vehicle/:vehicleId",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getVehicleTrips
);

// Trip stats for a specific vehicle
router.get(
    "/trips/vehicle/:vehicleId/stats",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getVehicleTripStats
);

// Manual trip detection trigger — internal/admin use, no feature gate
router.post("/trips/detect", async (req, res) => {
    try {
        const result = await TripDetectionCron.runManually();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Trip detection failed",
            error: error.message
        });
    }
});

// ========================================
// PARAMETER ROUTES LAST (after specific routes)
// ========================================

router.get(
    "/trips/:tripId/details-with-route",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getTripDetailsWithRoute
);

router.get(
    "/trips/:tripId",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getTripDetails
);

router.get(
    "/trips/:tripId/route",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.getTripRoute
);

router.delete(
    "/trips/:tripId",
    authMiddleware,
    requireFeature(FEATURES.TRIP_HISTORY),
    tripController.deleteTrip
);

module.exports = router;