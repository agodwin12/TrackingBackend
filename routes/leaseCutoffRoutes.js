// routes/leaseCutoffRoutes.js
const express        = require('express');
const router         = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { getCutoffTime } = require('../controllers/leaseCutoffController');

router.get('/lease/cutoff-time', authMiddleware, getCutoffTime);

module.exports = router;