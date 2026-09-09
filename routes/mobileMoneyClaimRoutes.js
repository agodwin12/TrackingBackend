// routes/mobileMoneyClaimRoutes.js
const express = require('express');
const router = express.Router();
const mobileMoneyClaimController = require('../controllers/mobileMoneyClaimController');
const authMiddleware = require('../middleware/authMiddleware');


router.post('/', authMiddleware, mobileMoneyClaimController.create);

module.exports = router;
