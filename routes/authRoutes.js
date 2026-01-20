// routes/auth.js
const express = require("express");
const { login, logout, refreshToken } = require("../controllers/authController");
const { loginValidation } = require("../middleware/authValidation");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Login route
router.post("/login", loginValidation, login);

// ✅ NEW: Refresh token route (no auth middleware needed - uses httpOnly cookie)
router.post("/refresh-token", refreshToken);

// ✅ Logout route (requires authentication)
router.post("/logout", authMiddleware, logout);

module.exports = router;