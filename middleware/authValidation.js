const { body } = require("express-validator");

/**
 * 🛡️ Login Validation Rules
 * Validates phone number and password before processing login
 */
exports.loginValidation = [
    // Phone Number Validation
    body("phone")
        .trim()
        .notEmpty()
        .withMessage("Phone number is required")
        .matches(/^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/)
        .withMessage("Invalid phone number format")
        .isLength({ min: 10, max: 20 })
        .withMessage("Phone number must be between 10 and 20 characters"),

    // Password Validation
    body("password")
        .trim()
        .notEmpty()
        .withMessage("Password is required")
        .isLength({ min: 6 })
        .withMessage("Password must be at least 6 characters long"),

    // Keep Me Logged In (Optional)
    body("keepMeLoggedIn")
        .optional()
        .isBoolean()
        .withMessage("Keep me logged in must be a boolean value"),
];

/**
 * 🛡️ Registration Validation Rules (for future use)
 */
exports.registerValidation = [
    // Name Validation
    body("nom")
        .trim()
        .notEmpty()
        .withMessage("Last name is required")
        .isLength({ min: 2, max: 50 })
        .withMessage("Last name must be between 2 and 50 characters")
        .matches(/^[a-zA-ZÀ-ÿ\s\-']+$/)
        .withMessage("Last name can only contain letters, spaces, hyphens, and apostrophes"),

    body("prenom")
        .trim()
        .notEmpty()
        .withMessage("First name is required")
        .isLength({ min: 2, max: 50 })
        .withMessage("First name must be between 2 and 50 characters")
        .matches(/^[a-zA-ZÀ-ÿ\s\-']+$/)
        .withMessage("First name can only contain letters, spaces, hyphens, and apostrophes"),

    // Phone Number Validation
    body("phone")
        .trim()
        .notEmpty()
        .withMessage("Phone number is required")
        .matches(/^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/)
        .withMessage("Invalid phone number format")
        .isLength({ min: 10, max: 20 })
        .withMessage("Phone number must be between 10 and 20 characters"),

    // Email Validation (Optional)
    body("email")
        .optional()
        .trim()
        .isEmail()
        .withMessage("Invalid email format")
        .normalizeEmail(),

    // Password Validation
    body("password")
        .trim()
        .notEmpty()
        .withMessage("Password is required")
        .isLength({ min: 8 })
        .withMessage("Password must be at least 8 characters long")
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage("Password must contain at least one uppercase letter, one lowercase letter, and one number"),

    // Ville (City) - Optional
    body("ville")
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage("City name must not exceed 100 characters"),

    // Quartier (District) - Optional
    body("quartier")
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage("District name must not exceed 100 characters"),
];

/**
 * 🛡️ Password Reset Validation
 */
exports.passwordResetValidation = [
    body("phone")
        .trim()
        .notEmpty()
        .withMessage("Phone number is required")
        .matches(/^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/)
        .withMessage("Invalid phone number format"),

    body("newPassword")
        .trim()
        .notEmpty()
        .withMessage("New password is required")
        .isLength({ min: 8 })
        .withMessage("Password must be at least 8 characters long")
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage("Password must contain at least one uppercase letter, one lowercase letter, and one number"),
];

/**
 * 🛡️ OTP Validation
 */
exports.otpValidation = [
    body("phone")
        .trim()
        .notEmpty()
        .withMessage("Phone number is required")
        .matches(/^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/)
        .withMessage("Invalid phone number format"),

    body("otp")
        .trim()
        .notEmpty()
        .withMessage("OTP is required")
        .isLength({ min: 4, max: 6 })
        .withMessage("OTP must be between 4 and 6 digits")
        .isNumeric()
        .withMessage("OTP must contain only numbers"),
];