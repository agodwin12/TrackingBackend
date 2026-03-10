// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const {
    initiatePayment,
    getPaymentHistory,
    getVehicleSubscription,
    getSubscriptionPlans,
    initiatePaymentBatch
} = require('../controllers/paymentController');

const authMiddleware = require('../middleware/authMiddleware');
// ──────────────────────────────────────────
// POST /api/payments/initiate
// User initiates a payment for a vehicle subscription
// ──────────────────────────────────────────


router.get('/plans', authMiddleware, getSubscriptionPlans);

router.post('/initiate-batch', authMiddleware, initiatePaymentBatch);

router.post('/initiate', authMiddleware, initiatePayment);

// ──────────────────────────────────────────
// GET /api/payments/history
// Get full payment history for logged in user
// ──────────────────────────────────────────
router.get('/history', authMiddleware, getPaymentHistory);

// ──────────────────────────────────────────
// GET /api/payments/vehicle/:vehicle_id
// Get active subscription for a specific vehicle
// ──────────────────────────────────────────
router.get('/vehicle/:vehicle_id', authMiddleware, getVehicleSubscription);

// Success redirect from Maviance
router.get('/success', (req, res) => {
    res.send('<h1>Payment Successful!</h1>');
});

// Cancel redirect from Maviance
router.get('/cancel', (req, res) => {
    res.send('<h1>Payment Cancelled</h1>');
});

module.exports = router;