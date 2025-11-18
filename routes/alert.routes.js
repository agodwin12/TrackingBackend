const express = require("express");
const router = express.Router();
const alertController = require("../controllers/alertController");

// GET /api/alerts/vehicle/:vehicleId
router.get("/vehicle/:vehicleId", alertController.getAlertsByVehicle);

router.patch("/:id/read", alertController.markAlertAsRead);

router.patch("/vehicle/:vehicleId/read-all", alertController.markAllAsRead);


module.exports = router;
