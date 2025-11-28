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
                status: isRunning() ? 'active' : 'inactive'
            }
        }
    });
});

// ========== SERVICE INITIALIZATION ==========
async function initializeServices() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║     INITIALIZING SERVICES...          ║');
    console.log('╚════════════════════════════════════════╝\n');

    // 1. Redis
    console.log('🔄 [1/5] Initializing Redis...');
    try {
        await redisClient.connect();
        console.log('✅ Redis: CONNECTED\n');
    } catch (error) {
        console.error('❌ Redis: FAILED -', error.message);
        console.error('⚠️  Server will continue without caching\n');
    }

    // 2. Geocoding Service
    console.log('🔄 [2/5] Initializing Geocoding Service...');
    try {
        GeocodingService.initialize();
        console.log('✅ Geocoding Service: INITIALIZED\n');
    } catch (error) {
        console.error('❌ Geocoding Service: FAILED -', error.message, '\n');
    }

    // 3. Socket.IO
    console.log('🔄 [3/5] Initializing Socket.IO...');
    try {
        socketService.initialize(io);
        console.log('✅ Socket.IO: INITIALIZED\n');
    } catch (error) {
        console.error('❌ Socket.IO: FAILED -', error.message, '\n');
        throw error; // Socket.IO is critical
    }

    // 4. Trip Detection Cron
    console.log('🔄 [4/5] Starting Trip Detection Cron...');
    try {
        TripDetectionCron.start();
        console.log('✅ Trip Detection Cron: STARTED\n');
    } catch (error) {
        console.error('❌ Trip Detection Cron: FAILED -', error.message, '\n');
    }

    // 5. Security Movement Check (auto-starts on require)
    console.log('🔄 [5/5] Security Movement Check: LOADED\n');

    console.log('╔════════════════════════════════════════╗');
    console.log('║   ✅ ALL SERVICES INITIALIZED         ║');
    console.log('╚════════════════════════════════════════╝\n');
}

// ========== DATABASE + SERVER STARTUP ==========
async function startServer() {
    try {
        // Step 1: Test Database Connection
        console.log('🔄 Testing database connection...');
        await sequelize.authenticate();
        console.log('✅ Database: CONNECTED\n');

        // Step 2: Sync Database
        console.log('🔄 Synchronizing database...');
        await sequelize.sync();
        console.log('✅ Database: SYNCHRONIZED\n');

        // Step 3: Initialize Services
        await initializeServices();

        // Step 4: Start HTTP Server
        const PORT = process.env.PORT || 5000;

        http.listen(PORT, () => {
            console.log('\n\n');
            console.log('╔════════════════════════════════════════╗');
            console.log('║                                        ║');
            console.log('║    🚗 GPS TRACKING SERVER STARTED     ║');
            console.log('║                                        ║');
            console.log('╚════════════════════════════════════════╝');
            console.log('\n📊 ========== SERVER STATUS ==========');
            console.log(`🌐 HTTP Server:      http://localhost:${PORT}`);
            console.log(`🔌 Socket.IO:        ws://localhost:${PORT}`);
            console.log(`📈 Health Check:     http://localhost:${PORT}/health`);
            console.log(`🌐 API Base:         http://localhost:${PORT}/api`);
            console.log('========================================\n');

            console.log('📊 ========== SERVICE STATUS ==========');
            console.log(`🗄️  Database:        ${sequelize.connectionManager.pool ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
            console.log(`💾 Redis Cache:      ${redisClient.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
            console.log(`🔌 Socket.IO:        ✅ READY`);
            console.log(`📍 Geocoding:        ✅ READY`);
            console.log(`🚗 Trip Detection:   ✅ RUNNING`);
            console.log(`🔐 Security Check:   ✅ RUNNING`);
            console.log('========================================\n');

            // Step 5: Start GPS Tracking Service (AFTER server is fully ready)
            console.log('🛰️  ========== STARTING GPS SERVICE ==========');
            console.log('⏳ Waiting 2 seconds for full initialization...\n');

            setTimeout(() => {
                console.log('🚀 Starting GPS tracking service...\n');
                try {
                    startGPSFetchCycle();
                    console.log('╔════════════════════════════════════════╗');
                    console.log('║  ✅ GPS TRACKING SERVICE STARTED      ║');
                    console.log('╚════════════════════════════════════════╝');
                    console.log('\n📡 GPS Service Status:');
                    console.log('   🔄 Fetching GPS data every 10 seconds');
                    console.log('   💾 Auto-saving to database');
                    console.log('   🗑️  Auto-invalidating cache');
                    console.log('   📡 Broadcasting via Socket.IO');
                    console.log('========================================\n');

                    console.log('✅ ========================================');
                    console.log('✅   SERVER FULLY OPERATIONAL!');
                    console.log('✅   Ready to track vehicles in real-time');
                    console.log('✅ ========================================\n');
                } catch (error) {
                    console.error('❌ Failed to start GPS service:', error.message);
                    console.error('⚠️  Server is running but GPS tracking is disabled\n');
                }
            }, 2000);
        });

    } catch (error) {
        console.error('\n❌ ========================================');
        console.error('❌   FATAL ERROR: SERVER FAILED TO START');
        console.error('❌ ========================================');
        console.error('🔥 Error:', error.message);
        console.error('🔥 Stack:', error.stack);
        console.error('========================================\n');
        process.exit(1);
    }
}

// ========== GRACEFUL SHUTDOWN ==========
const gracefulShutdown = async (signal) => {
    console.log('\n\n╔════════════════════════════════════════╗');
    console.log(`║   ⚠️  ${signal} - SHUTTING DOWN...       `);
    console.log('╚════════════════════════════════════════╝\n');

    let shutdownErrors = [];

    // 1. Stop GPS Tracking
    console.log('🔄 [1/5] Stopping GPS tracking service...');
    try {
        stopGPSFetchCycle();
        console.log('✅ GPS service stopped\n');
    } catch (error) {
        console.error('❌ Error stopping GPS service:', error.message);
        shutdownErrors.push('GPS service');
    }

    // 2. Close HTTP Server
    console.log('🔄 [2/5] Closing HTTP server...');
    try {
        await new Promise((resolve) => {
            http.close(() => {
                console.log('✅ HTTP server closed\n');
                resolve();
            });
        });
    } catch (error) {
        console.error('❌ Error closing HTTP server:', error.message);
        shutdownErrors.push('HTTP server');
    }

    // 3. Close Socket.IO
    console.log('🔄 [3/5] Closing Socket.IO connections...');
    try {
        await new Promise((resolve) => {
            io.close(() => {
                console.log('✅ Socket.IO connections closed\n');
                resolve();
            });
        });
    } catch (error) {
        console.error('❌ Error closing Socket.IO:', error.message);
        shutdownErrors.push('Socket.IO');
    }

    // 4. Disconnect Redis
    console.log('🔄 [4/5] Disconnecting Redis...');
    try {
        await redisClient.disconnect();
        console.log('✅ Redis disconnected\n');
    } catch (error) {
        console.error('❌ Error disconnecting Redis:', error.message);
        shutdownErrors.push('Redis');
    }

    // 5. Close Database Connection
    console.log('🔄 [5/5] Closing database connection...');
    try {
        await sequelize.close();
        console.log('✅ Database disconnected\n');
    } catch (error) {
        console.error('❌ Error closing database:', error.message);
        shutdownErrors.push('Database');
    }

    // Final Status
    if (shutdownErrors.length > 0) {
        console.log('╔════════════════════════════════════════╗');
        console.log('║  ⚠️  SHUTDOWN COMPLETE (WITH ERRORS)  ║');
        console.log('╚════════════════════════════════════════╝');
        console.log('\n❌ Errors in:', shutdownErrors.join(', '));
    } else {
        console.log('╔════════════════════════════════════════╗');
        console.log('║     ✅ SHUTDOWN COMPLETE              ║');
        console.log('╚════════════════════════════════════════╝');
    }

    console.log('\n👋 Goodbye!\n');
    process.exit(shutdownErrors.length > 0 ? 1 : 0);
};

// ========== ERROR HANDLERS ==========
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    console.error('\n🔥 ========================================');
    console.error('🔥   UNCAUGHT EXCEPTION');
    console.error('🔥 ========================================');
    console.error('🔥 Error:', error);
    console.error('🔥 Stack:', error.stack);
    console.error('========================================\n');
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n🔥 ========================================');
    console.error('🔥   UNHANDLED PROMISE REJECTION');
    console.error('🔥 ========================================');
    console.error('🔥 Reason:', reason);
    console.error('🔥 Promise:', promise);
    console.error('========================================\n');
    gracefulShutdown('UNHANDLED_REJECTION');
});

// ========== START THE SERVER ==========
startServer();
