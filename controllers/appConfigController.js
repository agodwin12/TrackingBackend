// controllers/appConfigController.js
const logger = require('../utils/logger');

const getAppConfig = (req, res) => {
    try {
        res.json({
            show_payment_ui: process.env.SHOW_PAYMENT_UI === 'true'
        });
    } catch (err) {
        logger.error('Error fetching app config:', err.message);
        res.status(500).json({ show_payment_ui: false }); // fail safe — always hide
    }
};

module.exports = { getAppConfig };