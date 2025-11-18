// backend/routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const authMiddleware = require('../middleware/authMiddleware');

// All notification routes require authentication
router.use(authMiddleware);

// Register device token for push notifications
router.post('/register-token', notificationController.registerToken);

// Unregister device token (on logout)
router.post('/unregister-token', notificationController.unregisterToken);

// Get all registered devices for current user
router.get('/devices', notificationController.getDevices);

// Send test notification
router.post('/test', notificationController.sendTestNotification);

module.exports = router;