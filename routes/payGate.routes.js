const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');


// On importe le contrôleur
const paymentController = require('../controllers/paygateController');

/**
 * Routes liées aux paiements
 * Préfixe de base: /api/payment (défini dans ton app.js)
 */

// POST /api/payment/checkout
router.use(authMiddleware);
router.post('/checkout', paymentController.initiateCheckout);

module.exports = router;