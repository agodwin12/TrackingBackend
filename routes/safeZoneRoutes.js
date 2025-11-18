// routes/safeZoneRoutes.js
const express = require('express');
const router = express.Router();
const safeZoneController = require('../controllers/safeZoneController');
const authMiddleware = require('../middleware/authMiddleware');

// All routes require authentication
router.use(authMiddleware);

// Create a new safe zone
router.post('/', safeZoneController.createSafeZone);

// Get all safe zones for the authenticated user
router.get('/', safeZoneController.getAllSafeZones);

// Get safe zone for a specific vehicle
router.get('/vehicle/:vehicle_id', safeZoneController.getSafeZone);

// Update a safe zone
router.put('/:id', safeZoneController.updateSafeZone);

// Toggle safe zone active/inactive
router.patch('/:id/toggle', safeZoneController.toggleSafeZone);

// Delete a safe zone
router.delete('/:id', safeZoneController.deleteSafeZone);

module.exports = router;