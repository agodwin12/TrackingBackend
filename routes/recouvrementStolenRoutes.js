// routes/recouvrementStolenRoutes.js

const express = require("express");
const router = express.Router();

const {
    reportStolenFromRecouvrement,
} = require("../controllers/recouvrementStolenController");



router.post("/report-stolen", reportStolenFromRecouvrement);

module.exports = router;