const express = require("express");
const router = express.Router();
const tripController = require("../controllers/tripController");
const TripDetectionCron = require("../jobs/tripDetectionCron");

// ========================================
// SPECIFIC ROUTES FIRST (before parameters)
// ========================================

// Get all trips
router.get("/trips", tripController.getAllTrips);

// Get trips for a specific vehicle
router.get("/trips/vehicle/:vehicleId", tripController.getVehicleTrips);

// Get trip statistics for a specific vehicle
router.get("/trips/vehicle/:vehicleId/stats", tripController.getVehicleTripStats);

// Manual trip detection trigger
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

// ✅ FIXED: Changed from /details to /details-with-route
router.get("/trips/:tripId/details-with-route", tripController.getTripDetailsWithRoute);

// Get basic trip details
router.get("/trips/:tripId", tripController.getTripDetails);

// Get trip route waypoints only
router.get("/trips/:tripId/route", tripController.getTripRoute);

// Delete a trip
router.delete("/trips/:tripId", tripController.deleteTrip);

module.exports = router;