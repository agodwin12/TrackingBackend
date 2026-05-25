// routes/pinRoutes.js
const express        = require('express');
const router         = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const pinController  = require('../controllers/pinController');

router.post  ('/set',    authMiddleware, pinController.setPin);
router.post  ('/verify', authMiddleware, pinController.verifyPin);
router.get   ('/exists', authMiddleware, pinController.checkPinExists);
router.delete('/delete', authMiddleware, pinController.deletePin);
router.post  ('/change', authMiddleware, pinController.changePin);

module.exports = router;