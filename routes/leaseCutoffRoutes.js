// routes/leaseCutoffRoutes.js
const express = require('express');
const router  = express.Router();
const leaseCutoffController = require('../controllers/leaseCutoffController');

router.get('/lease/cutoff-time', leaseCutoffController.getCutoffTime);
//          ^^^^^^ add /lease/ prefix

module.exports = router;