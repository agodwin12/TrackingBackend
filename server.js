// server.js - SERVER LIFECYCLE MANAGEMENT (HTTP + Socket.IO + Services)

// ✅ LOAD ENVIRONMENT VARIABLES FIRST (before any other imports)
require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const sequelize = require('./config/database');
const redisClient = require('./config/redis');
const socketService = require('./services/socketService');
const logger = require('./utils/logger');
const { startGPSFetchCycle, stopGPSFetchCycle, isRunning } = require('./location');
const TripDetectionCron      = require('./jobs/tripDetectionCron');
const SubscriptionExpiryCron = require('./jobs/subscriptionExpiryCron');  // ✅ NEW
const GeocodingService = require('./services/geocodingService');

// ✅ Security Check Job
require('./jobs/checkSecurityMovement');

// ========== HTTP SERVER SETUP ==========
const httpServer = http.createServer(app);

// ========== SOCKET.IO SETUP ==========
const io = new Server(httpServer, {
    cors: {
        origin: process.env.NODE_ENV === 'production'
            ? [process.env.FLUTTER_APP_DOMAIN]
            : ['http://localhost:3000', 'http://10.0.2.2:5000'],
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// ========== SERVICE INITIALIZATION ==========
async function initializeServices() {
    logger.info('\n╔════════════════════════════════════════╗');
    logger.info('║     INITIALIZING SERVICES...          ║');
    logger.info('╚════════════════════════════════════════╝\n');

    const errors = [];

    // 1. Redis
    logger.info('🔄 [1/6] Initializing Redis...');
    try {
        await redisClient.connect();
        logger.info('✅ Redis: CONNECTED\n');
    } catch (error) {
        logger.error('❌ Redis: FAILED -', error.message);
        logger.warn('⚠️  Server will continue without caching\n');
        errors.push('Redis');
    }

    // 2. Geocoding Service
    logger.info('🔄 [2/6] Initializing Geocoding Service...');
    try {
        GeocodingService.initialize();
        logger.info('✅ Geocoding Service: INITIALIZED\n');
    } catch (error) {
        logger.error('❌ Geocoding Service: FAILED -', error.message, '\n');
        errors.push('Geocoding');
    }

    // 3. Socket.IO
    logger.info('🔄 [3/6] Initializing Socket.IO...');
    try {
        socketService.initialize(io);
        logger.info('✅ Socket.IO: INITIALIZED\n');
    } catch (error) {
        logger.error('❌ Socket.IO: FAILED -', error.message, '\n');
        throw error; // Socket.IO is critical
    }

    // 4. Trip Detection Cron
    logger.info('🔄 [4/6] Starting Trip Detection Cron...');
    try {
        TripDetectionCron.start();
        logger.info('✅ Trip Detection Cron: STARTED\n');
    } catch (error) {
        logger.error('❌ Trip Detection Cron: FAILED -', error.message, '\n');
        errors.push('Trip Detection');
    }

    // 5. Subscription Expiry Cron  ✅ NEW
    logger.info('🔄 [5/6] Starting Subscription Expiry Cron...');
    try {
        SubscriptionExpiryCron.start();
        logger.info('✅ Subscription Expiry Cron: STARTED (daily at 08:00)\n');
    } catch (error) {
        logger.error('❌ Subscription Expiry Cron: FAILED -', error.message, '\n');
        errors.push('Subscription Expiry');
    }

    // 6. Security Movement Check
    logger.info('🔄 [6/6] Security Movement Check: LOADED\n');

    if (errors.length > 0) {
        logger.warn(`⚠️ Some services failed: ${errors.join(', ')}`);
    }

    logger.info('╔════════════════════════════════════════╗');
    logger.info('║   ✅ SERVICE INITIALIZATION COMPLETE  ║');
    logger.info('╚════════════════════════════════════════╝\n');
}

// ========== SERVER STARTUP ==========
async function startServer() {
    try {
        // Step 1: Database Connection
        logger.info('🔄 Testing database connection...');
        await sequelize.authenticate();
        logger.info('✅ Database: CONNECTED\n');

        // Step 2: Database Sync
        logger.info('🔄 Synchronizing database...');
        await sequelize.sync();
        logger.info('✅ Database: SYNCHRONIZED\n');

        // Step 3: Initialize Services
        await initializeServices();

        // Step 4: Start HTTP Server
        const PORT = process.env.PORT || 5000;
        const HOST = process.env.HOST || '0.0.0.0';

        httpServer.listen(PORT, HOST, () => {
            logger.info('\n╔════════════════════════════════════════╗');
            logger.info('║    🚗 GPS TRACKING SERVER STARTED     ║');
            logger.info('╚════════════════════════════════════════╝\n');
            logger.info(`🌐 Server:           http://${HOST}:${PORT}`);
            logger.info(`🔌 Socket.IO:        ws://${HOST}:${PORT}`);
            logger.info(`📈 Health:           http://${HOST}:${PORT}/health`);
            logger.info(`🏭 Environment:      ${process.env.NODE_ENV || 'development'}\n`);

            // Step 5: Start GPS Service (delayed)
            setTimeout(() => {
                try {
                    logger.info('🚀 Starting GPS tracking service...');
                    startGPSFetchCycle();
                    logger.info('✅ GPS TRACKING: ACTIVE\n');
                } catch (error) {
                    logger.error('❌ GPS service failed:', error.message);
                }
            }, 2000);
        });

    } catch (error) {
        logger.error('❌ FATAL: Server failed to start');
        logger.error('🔥 Error:', error.message);
        logger.error('🔥 Stack:', error.stack);
        process.exit(1);
    }
}

// ========== GRACEFUL SHUTDOWN ==========
async function gracefulShutdown(signal) {
    logger.info(`\n⚠️  ${signal} - Shutting down gracefully...`);

    const errors = [];

    // 1. Stop GPS
    try {
        if (isRunning()) {
            stopGPSFetchCycle();
            logger.info('✅ GPS service stopped');
        } else {
            logger.info('ℹ️  GPS service was not running');
        }
    } catch (error) {
        logger.error('❌ GPS shutdown failed:', error.message);
        errors.push('GPS');
    }

    // 2. Close HTTP Server
    try {
        await new Promise((resolve) => httpServer.close(resolve));
        logger.info('✅ HTTP server closed');
    } catch (error) {
        logger.error('❌ HTTP server close failed:', error.message);
        errors.push('HTTP');
    }

    // 3. Close Socket.IO
    try {
        await new Promise((resolve) => io.close(resolve));
        logger.info('✅ Socket.IO closed');
    } catch (error) {
        logger.error('❌ Socket.IO close failed:', error.message);
        errors.push('Socket.IO');
    }

    // 4. Disconnect Redis
    try {
        if (redisClient.isOpen) {
            await redisClient.disconnect();
            logger.info('✅ Redis disconnected');
        } else {
            logger.info('ℹ️  Redis was not connected');
        }
    } catch (error) {
        logger.error('❌ Redis disconnect failed:', error.message);
        errors.push('Redis');
    }

    // 5. Close Database
    try {
        await sequelize.close();
        logger.info('✅ Database closed');
    } catch (error) {
        logger.error('❌ Database close failed:', error.message);
        errors.push('Database');
    }

    // 6. Stop Cron Jobs
    try {
        TripDetectionCron.stop();
        logger.info('✅ Trip Detection Cron stopped');
    } catch (error) {
        logger.error('❌ Trip Detection Cron stop failed:', error.message);
        errors.push('TripCron');
    }

    // 7. Stop Subscription Expiry Cron  ✅ NEW
    try {
        SubscriptionExpiryCron.stop();
        logger.info('✅ Subscription Expiry Cron stopped');
    } catch (error) {
        logger.error('❌ Subscription Expiry Cron stop failed:', error.message);
        errors.push('ExpiryCron');
    }

    logger.info('\n╔════════════════════════════════════════╗');
    if (errors.length > 0) {
        logger.warn(`║  ⚠️  SHUTDOWN COMPLETE (${errors.length} errors)      ║`);
        logger.warn(`║     Failed: ${errors.join(', ').padEnd(25)}║`);
    } else {
        logger.info('║      ✅ SHUTDOWN COMPLETE             ║');
    }
    logger.info('╚════════════════════════════════════════╝\n');

    process.exit(errors.length > 0 ? 1 : 0);
}

// ========== ERROR HANDLERS ==========
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    logger.error('\n╔════════════════════════════════════════╗');
    logger.error('║      🔥 UNCAUGHT EXCEPTION            ║');
    logger.error('╚════════════════════════════════════════╝');
    logger.error('Error:', error.message);
    logger.error('Stack:', error.stack);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('🔥 UNHANDLED REJECTION (non-fatal, process continues)');
    logger.error('Reason:', reason);
});

// ========== VERIFY CRITICAL ENVIRONMENT VARIABLES ==========
const requiredEnvVars = [
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
    'GPS_LOGIN_NAME_1',
    'GPS_LOGIN_PASSWORD_1'
];

const optionalButDefinedVars = [
    'DB_PASSWORD',
    'REDIS_PASSWORD'
];

logger.info('\n🔍 Checking required environment variables...');

const missingVars = requiredEnvVars.filter(varName => process.env[varName] === undefined);
const undefinedOptionalVars = optionalButDefinedVars.filter(varName => process.env[varName] === undefined);

if (missingVars.length > 0 || undefinedOptionalVars.length > 0) {
    logger.error('❌ Missing required environment variables:');

    if (missingVars.length > 0) {
        logger.error('\n  Required (must have value):');
        missingVars.forEach(varName => logger.error(`   - ${varName}`));
    }

    if (undefinedOptionalVars.length > 0) {
        logger.error('\n  Required (can be empty, but must be defined):');
        undefinedOptionalVars.forEach(varName => logger.error(`   - ${varName}`));
    }

    logger.error('\n⚠️  Please check your .env file');
    process.exit(1);
} else {
    logger.info('✅ All required environment variables are set');

    const emptyPasswords = optionalButDefinedVars.filter(varName => process.env[varName] === '');
    if (emptyPasswords.length > 0) {
        logger.warn(`⚠️  Note: Empty passwords detected for: ${emptyPasswords.join(', ')}`);
    }

    logger.info('');
}

// ========== START THE SERVER ==========
startServer();