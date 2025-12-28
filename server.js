// server.js - SERVER LIFECYCLE MANAGEMENT (HTTP + Socket.IO + Services)
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const app = require('./app');
const sequelize = require('./config/database');
const redisClient = require('./config/redis');
const socketService = require('./services/socketService');
const logger = require('./utils/logger');
const { startGPSFetchCycle, stopGPSFetchCycle, isRunning } = require('./location');
const TripDetectionCron = require('./jobs/tripDetectionCron');
const GeocodingService = require('./services/geocodingService');

// ✅ Security Check Job
require('./jobs/checkSecurityMovement');

dotenv.config();

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
    transports: ['websocket', 'polling'], // ✅ Explicit transports
    allowEIO3: true // ✅ Support older clients
});

// ========== SERVICE INITIALIZATION ==========
async function initializeServices() {
    logger.info('\n╔════════════════════════════════════════╗');
    logger.info('║     INITIALIZING SERVICES...          ║');
    logger.info('╚════════════════════════════════════════╝\n');

    const errors = [];

    // 1. Redis
    logger.info('🔄 [1/5] Initializing Redis...');
    try {
        await redisClient.connect();
        logger.info('✅ Redis: CONNECTED\n');
    } catch (error) {
        logger.error('❌ Redis: FAILED -', error.message);
        logger.warn('⚠️  Server will continue without caching\n');
        errors.push('Redis');
    }

    // 2. Geocoding Service
    logger.info('🔄 [2/5] Initializing Geocoding Service...');
    try {
        GeocodingService.initialize();
        logger.info('✅ Geocoding Service: INITIALIZED\n');
    } catch (error) {
        logger.error('❌ Geocoding Service: FAILED -', error.message, '\n');
        errors.push('Geocoding');
    }

    // 3. Socket.IO
    logger.info('🔄 [3/5] Initializing Socket.IO...');
    try {
        socketService.initialize(io);
        logger.info('✅ Socket.IO: INITIALIZED\n');
    } catch (error) {
        logger.error('❌ Socket.IO: FAILED -', error.message, '\n');
        throw error; // Socket.IO is critical
    }

    // 4. Trip Detection Cron
    logger.info('🔄 [4/5] Starting Trip Detection Cron...');
    try {
        TripDetectionCron.start();
        logger.info('✅ Trip Detection Cron: STARTED\n');
    } catch (error) {
        logger.error('❌ Trip Detection Cron: FAILED -', error.message, '\n');
        errors.push('Trip Detection');
    }

    // 5. Security Movement Check
    logger.info('🔄 [5/5] Security Movement Check: LOADED\n');

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
        process.exit(1);
    }
}

// ========== GRACEFUL SHUTDOWN ==========
async function gracefulShutdown(signal) {
    logger.info(`\n⚠️  ${signal} - Shutting down gracefully...`);

    const errors = [];

    // 1. Stop GPS
    try {
        stopGPSFetchCycle();
        logger.info('✅ GPS service stopped');
    } catch (error) {
        errors.push('GPS');
    }

    // 2. Close HTTP Server
    try {
        await new Promise((resolve) => httpServer.close(resolve));
        logger.info('✅ HTTP server closed');
    } catch (error) {
        errors.push('HTTP');
    }

    // 3. Close Socket.IO
    try {
        await new Promise((resolve) => io.close(resolve));
        logger.info('✅ Socket.IO closed');
    } catch (error) {
        errors.push('Socket.IO');
    }

    // 4. Disconnect Redis
    try {
        await redisClient.disconnect();
        logger.info('✅ Redis disconnected');
    } catch (error) {
        errors.push('Redis');
    }

    // 5. Close Database
    try {
        await sequelize.close();
        logger.info('✅ Database closed');
    } catch (error) {
        errors.push('Database');
    }

    logger.info(errors.length > 0
        ? `⚠️  Shutdown complete (errors: ${errors.join(', ')})`
        : '✅ Shutdown complete'
    );

    process.exit(errors.length > 0 ? 1 : 0);
}

// ========== ERROR HANDLERS ==========
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    logger.error('🔥 UNCAUGHT EXCEPTION:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    logger.error('🔥 UNHANDLED REJECTION:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});

// ========== START THE SERVER ==========
startServer();