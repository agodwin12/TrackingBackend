// server.js - GPS TRACKING SERVER WITH SOCKET.IO + GPS SERVICE
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { Server } = require('socket.io');
const dotenv = require("dotenv");
const sequelize = require("./config/database");
const redisClient = require("./config/redis");
const socketService = require("./services/socketService");
const logger = require("./utils/logger"); // ✅ NEW: Import logger

// ✅ Import Routes
const vehicleRoutes = require("./routes/vehicleRoutes");
const authRoutes = require("./routes/authRoutes");
const voitureRoutes = require("./routes/voitureRoutes");
const dashboardVehicleRoutes = require("./routes/dashboardVehicleRoutes");
const gpsRoutes = require("./routes/gpsRoutes");
const userRoutes = require("./routes/userRoutes");
const changePasswordRoutes = require("./routes/ChangePasswordRoutes");
const vehicleLocationRoutes = require("./routes/vehicleLocationRoutes");
const vehicleSecurityRoutes = require('./routes/vehicleSecurityRoutes');
const tripRoutes = require("./routes/tripRoutes");
const alertRoutes = require("./routes/alert.routes");
const gpsStatus = require("./routes/gpsStatusRoute");
const safeZoneRoutes = require('./routes/safeZoneRoutes');
const TripDetectionCron = require("./jobs/tripDetectionCron");
const GeocodingService = require('./services/geocodingService');
const { startGPSFetchCycle, stopGPSFetchCycle, isRunning } = require("./location");
const notificationRoutes = require('./routes/notificationRoutes');
const userSettingsRoutes = require('./routes/userSettingsRoutes');
const pinRoutes = require('./routes/pinRoutes');
const geofenceRoutes = require('./routes/geofenceRoutes');

// ✅ Security Check Job
require('./jobs/checkSecurityMovement');

dotenv.config();

// ========== EXPRESS APP SETUP ==========
const app = express();
const http = require('http').createServer(app);

// ========== SOCKET.IO SETUP ==========
const io = new Server(http, {
    cors: {
        origin: "*", // ⚠️ For production, specify your Flutter app's domain
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());

// ========== API ROUTES ==========
app.use("/api/auth", authRoutes);
app.use("/api", voitureRoutes);
app.use("/api", vehicleRoutes);
app.use("/api", dashboardVehicleRoutes);
app.use("/api", gpsRoutes);
app.use("/api/users", userRoutes);
app.use("/api", changePasswordRoutes);
app.use("/api/tracking", vehicleLocationRoutes);
app.use('/api', vehicleSecurityRoutes);
app.use("/api", tripRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/gps", gpsStatus);
app.use('/api/safezones', safeZoneRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/users-settings', userSettingsRoutes);
app.use('/api/pin', pinRoutes);
app.use('/api/geofence', geofenceRoutes);


// ========== HEALTH CHECK ENDPOINT ==========
app.get('/health', (req, res) => {
    const stats = socketService.getStats();
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        services: {
            database: sequelize.connectionManager.pool ? 'connected' : 'disconnected',
            redis: redisClient.isConnected ? 'connected' : 'disconnected',
            socketIO: {
                connected: true,
                totalConnections: stats.totalConnections,
                activeRooms: stats.rooms.length
            },
            gpsTracking: {
                running: isRunning(),
                status: isRunning() ? 'active' : 'inactive',
                intervalSeconds: parseInt(process.env.GPS_FETCH_INTERVAL) / 1000
            }
        }
    });
});

// ========== SERVICE INITIALIZATION ==========
async function initializeServices() {
    logger.info('\n╔════════════════════════════════════════╗');
    logger.info('║     INITIALIZING SERVICES...          ║');
    logger.info('╚════════════════════════════════════════╝\n');

    // 1. Redis
    logger.info('🔄 [1/5] Initializing Redis...');
    try {
        await redisClient.connect();
        logger.info('✅ Redis: CONNECTED\n');
    } catch (error) {
        logger.error('❌ Redis: FAILED -', error.message);
        logger.warn('⚠️  Server will continue without caching\n');
    }

    // 2. Geocoding Service
    logger.info('🔄 [2/5] Initializing Geocoding Service...');
    try {
        GeocodingService.initialize();
        logger.info('✅ Geocoding Service: INITIALIZED\n');
    } catch (error) {
        logger.error('❌ Geocoding Service: FAILED -', error.message, '\n');
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
    }

    // 5. Security Movement Check (auto-starts on require)
    logger.info('🔄 [5/5] Security Movement Check: LOADED\n');

    logger.info('╔════════════════════════════════════════╗');
    logger.info('║   ✅ ALL SERVICES INITIALIZED         ║');
    logger.info('╚════════════════════════════════════════╝\n');
}

// ========== DATABASE + SERVER STARTUP ==========
async function startServer() {
    try {
        // Step 1: Test Database Connection
        logger.info('🔄 Testing database connection...');
        await sequelize.authenticate();
        logger.info('✅ Database: CONNECTED\n');

        // Step 2: Sync Database
        logger.info('🔄 Synchronizing database...');
        await sequelize.sync();
        logger.info('✅ Database: SYNCHRONIZED\n');

        // Step 3: Initialize Services
        await initializeServices();

        // Step 4: Start HTTP Server
        const PORT = process.env.PORT || 5000;

        http.listen(PORT, '0.0.0.0', () => {
            logger.info('\n\n');
            logger.info('╔════════════════════════════════════════╗');
            logger.info('║                                        ║');
            logger.info('║    🚗 GPS TRACKING SERVER STARTED     ║');
            logger.info('║                                        ║');
            logger.info('╚════════════════════════════════════════╝');
            logger.info('\n📊 ========== SERVER STATUS ==========');
            logger.info(`🌐 HTTP Server:      http://localhost:${PORT}`);
            logger.info(`🔌 Socket.IO:        ws://localhost:${PORT}`);
            logger.info(`📈 Health Check:     http://localhost:${PORT}/health`);
            logger.info(`🌐 API Base:         http://localhost:${PORT}/api`);
            logger.info(`🏭 Environment:      ${process.env.NODE_ENV || 'development'}`);
            logger.info('========================================\n');

            logger.info('📊 ========== SERVICE STATUS ==========');
            logger.info(`🗄️  Database:        ${sequelize.connectionManager.pool ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
            logger.info(`💾 Redis Cache:      ${redisClient.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
            logger.info(`🔌 Socket.IO:        ✅ READY`);
            logger.info(`📍 Geocoding:        ✅ READY`);
            logger.info(`🚗 Trip Detection:   ✅ RUNNING`);
            logger.info(`🔐 Security Check:   ✅ RUNNING`);
            logger.info('========================================\n');

            // Step 5: Start GPS Tracking Service (AFTER server is fully ready)
            logger.info('🛰️  ========== STARTING GPS SERVICE ==========');
            logger.debug('⏳ Waiting 2 seconds for full initialization...\n');

            setTimeout(() => {
                logger.info('🚀 Starting GPS tracking service...\n');
                try {
                    startGPSFetchCycle();
                    logger.info('╔════════════════════════════════════════╗');
                    logger.info('║  ✅ GPS TRACKING SERVICE STARTED      ║');
                    logger.info('╚════════════════════════════════════════╝');
                    logger.info('\n📡 GPS Service Status:');
                    logger.info(`   🔄 Fetching GPS data every ${process.env.GPS_FETCH_INTERVAL / 1000} seconds`);
                    logger.info('   💾 Auto-saving to database');
                    logger.info('   🗑️  Auto-invalidating cache');
                    logger.info('   📡 Broadcasting via Socket.IO');
                    logger.info('========================================\n');

                    logger.info('✅ ========================================');
                    logger.info('✅   SERVER FULLY OPERATIONAL!');
                    logger.info('✅   Ready to track vehicles in real-time');
                    logger.info('✅ ========================================\n');
                } catch (error) {
                    logger.error('❌ Failed to start GPS service:', error.message);
                    logger.warn('⚠️  Server is running but GPS tracking is disabled\n');
                }
            }, 2000);
        });

    } catch (error) {
        logger.error('\n❌ ========================================');
        logger.error('❌   FATAL ERROR: SERVER FAILED TO START');
        logger.error('❌ ========================================');
        logger.error('🔥 Error:', error.message);
        logger.error('🔥 Stack:', error.stack);
        logger.error('========================================\n');
        process.exit(1);
    }
}

// ========== GRACEFUL SHUTDOWN ==========
const gracefulShutdown = async (signal) => {
    logger.info('\n\n╔════════════════════════════════════════╗');
    logger.info(`║   ⚠️  ${signal} - SHUTTING DOWN...       `);
    logger.info('╚════════════════════════════════════════╝\n');

    let shutdownErrors = [];

    // 1. Stop GPS Tracking
    logger.info('🔄 [1/5] Stopping GPS tracking service...');
    try {
        stopGPSFetchCycle();
        logger.info('✅ GPS service stopped\n');
    } catch (error) {
        logger.error('❌ Error stopping GPS service:', error.message);
        shutdownErrors.push('GPS service');
    }

    // 2. Close HTTP Server
    logger.info('🔄 [2/5] Closing HTTP server...');
    try {
        await new Promise((resolve) => {
            http.close(() => {
                logger.info('✅ HTTP server closed\n');
                resolve();
            });
        });
    } catch (error) {
        logger.error('❌ Error closing HTTP server:', error.message);
        shutdownErrors.push('HTTP server');
    }

    // 3. Close Socket.IO
    logger.info('🔄 [3/5] Closing Socket.IO connections...');
    try {
        await new Promise((resolve) => {
            io.close(() => {
                logger.info('✅ Socket.IO connections closed\n');
                resolve();
            });
        });
    } catch (error) {
        logger.error('❌ Error closing Socket.IO:', error.message);
        shutdownErrors.push('Socket.IO');
    }

    // 4. Disconnect Redis
    logger.info('🔄 [4/5] Disconnecting Redis...');
    try {
        await redisClient.disconnect();
        logger.info('✅ Redis disconnected\n');
    } catch (error) {
        logger.error('❌ Error disconnecting Redis:', error.message);
        shutdownErrors.push('Redis');
    }

    // 5. Close Database Connection
    logger.info('🔄 [5/5] Closing database connection...');
    try {
        await sequelize.close();
        logger.info('✅ Database disconnected\n');
    } catch (error) {
        logger.error('❌ Error closing database:', error.message);
        shutdownErrors.push('Database');
    }

    // Final Status
    if (shutdownErrors.length > 0) {
        logger.warn('╔════════════════════════════════════════╗');
        logger.warn('║  ⚠️  SHUTDOWN COMPLETE (WITH ERRORS)  ║');
        logger.warn('╚════════════════════════════════════════╝');
        logger.warn('\n❌ Errors in:', shutdownErrors.join(', '));
    } else {
        logger.info('╔════════════════════════════════════════╗');
        logger.info('║     ✅ SHUTDOWN COMPLETE              ║');
        logger.info('╚════════════════════════════════════════╝');
    }

    logger.info('\n👋 Goodbye!\n');
    process.exit(shutdownErrors.length > 0 ? 1 : 0);
};

// ========== ERROR HANDLERS ==========
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    logger.error('\n🔥 ========================================');
    logger.error('🔥   UNCAUGHT EXCEPTION');
    logger.error('🔥 ========================================');
    logger.error('🔥 Error:', error);
    logger.error('🔥 Stack:', error.stack);
    logger.error('========================================\n');
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('\n🔥 ========================================');
    logger.error('🔥   UNHANDLED PROMISE REJECTION');
    logger.error('🔥 ========================================');
    logger.error('🔥 Reason:', reason);
    logger.error('🔥 Promise:', promise);
    logger.error('========================================\n');
    gracefulShutdown('UNHANDLED_REJECTION');
});

// ========== START THE SERVER ==========
startServer();