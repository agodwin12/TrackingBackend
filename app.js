// app.js - EXPRESS APP CONFIGURATION (NO SERVER LOGIC)
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // ✅ NEW: Security headers
const compression = require('compression'); // ✅ NEW: Gzip compression
const morgan = require('morgan'); // ✅ NEW: Request logging
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

// ✅ Import Routes
const vehicleRoutes = require('./routes/vehicleRoutes');
const authRoutes = require('./routes/authRoutes');
const voitureRoutes = require('./routes/voitureRoutes');
const dashboardVehicleRoutes = require('./routes/dashboardVehicleRoutes');
const gpsRoutes = require('./routes/gpsRoutes');
const userRoutes = require('./routes/userRoutes');
const changePasswordRoutes = require('./routes/ChangePasswordRoutes');
const vehicleLocationRoutes = require('./routes/vehicleLocationRoutes');
const vehicleSecurityRoutes = require('./routes/vehicleSecurityRoutes');
const tripRoutes = require('./routes/tripRoutes');
const alertRoutes = require('./routes/alert.routes');
const gpsStatus = require('./routes/gpsStatusRoute');
const safeZoneRoutes = require('./routes/safeZoneRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const userSettingsRoutes = require('./routes/userSettingsRoutes');
const pinRoutes = require('./routes/pinRoutes');
const geofenceRoutes = require('./routes/geofenceRoutes');
const paygate = require('./routes/payGate.routes')
// ========== EXPRESS APP SETUP ==========
const app = express();

// ========== SECURITY MIDDLEWARE ==========
// 🛡️ Helmet - Sets secure HTTP headers
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for API
    crossOriginEmbedderPolicy: false
}));

// 🛡️ CORS - Configure properly for production
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? [process.env.FLUTTER_APP_DOMAIN] // Set this in .env
    : ['http://localhost:3000', 'http://10.0.2.2:5000']; // Development

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            logger.warn(`⚠️ Blocked CORS request from: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// ========== PERFORMANCE MIDDLEWARE ==========
// 📦 Compression - Gzip responses
app.use(compression());

// 📝 Request Logging - Morgan
if (process.env.NODE_ENV === 'production') {
    // Production: Log only errors
    app.use(morgan('combined', {
        skip: (req, res) => res.statusCode < 400,
        stream: { write: (message) => logger.error(message.trim()) }
    }));
} else {
    // Development: Log all requests
    app.use(morgan('dev', {
        stream: { write: (message) => logger.debug(message.trim()) }
    }));
}

// ========== BODY PARSERS ==========
app.use(bodyParser.json({ limit: '10mb' })); // ✅ Limit body size
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ========== RATE LIMITING ==========
// 🛡️ 1. General API Rate Limiter
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // ✅ Adjusted from 1000 to 500 for production
    message: { message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`⚠️ Rate limit exceeded: IP=${req.ip}, Path=${req.path}`);
        res.status(429).json({
            message: 'Too many requests, please try again later.'
        });
    }
});

// 🛡️ 2. Strict Auth Rate Limiter
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    message: { message: 'Too many authentication attempts.' },
    handler: (req, res) => {
        logger.warn(`🚨 Auth rate limit: IP=${req.ip}, Phone=${req.body.phone || 'N/A'}`);
        res.status(429).json({
            message: 'Too many authentication attempts. Please try again after 15 minutes.'
        });
    }
});

// 🛡️ 3. OTP/SMS Rate Limiter
const otpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: { message: 'Too many OTP requests.' },
    handler: (req, res) => {
        logger.warn(`🚨 OTP rate limit: IP=${req.ip}, Phone=${req.body.phone || 'N/A'}`);
        res.status(429).json({
            message: 'Too many OTP requests. Please try again after 1 hour.'
        });
    }
});

// 🛡️ 4. GPS Tracking Rate Limiter (specific for tracking endpoints)
const trackingLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute = 1 per second
    message: { message: 'GPS tracking rate limit exceeded.' }
});

// ========== APPLY RATE LIMITERS ==========
app.use('/api', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-otp', otpLimiter);
app.use('/api/auth/send-otp', otpLimiter);
app.use('/api/tracking', trackingLimiter);

// ========== HEALTH CHECK (NO RATE LIMIT) ==========
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ========== API ROUTES ==========
app.use('/api/auth', authRoutes);
app.use('/api', voitureRoutes);
app.use('/api', vehicleRoutes);
app.use('/api', dashboardVehicleRoutes);
app.use('/api', gpsRoutes);
app.use('/api/gps', gpsStatus);
app.use('/api/users', userRoutes);
app.use('/api', changePasswordRoutes);
app.use('/api/tracking', vehicleLocationRoutes);
app.use('/api', vehicleSecurityRoutes);
app.use('/api', tripRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/safezones', safeZoneRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/users-settings', userSettingsRoutes);
app.use('/api/pin', pinRoutes);
app.use('/api/geofence', geofenceRoutes);
app.use('/api',paygate);

// ========== 404 HANDLER ==========
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
        path: req.path
    });
});

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
    logger.error(`🔥 Error: ${err.message}`, {
        path: req.path,
        method: req.method,
        ip: req.ip,
        stack: err.stack
    });

    res.status(err.status || 500).json({
        success: false,
        message: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
});

module.exports = app;