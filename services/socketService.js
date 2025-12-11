// services/socketService.js
class SocketService {
    constructor() {
        this.io = null;
        this.connectedClients = new Map(); // Track connected clients by vehicleId
        console.log('🔌 SocketService instance created');
    }

    /**
     * Initialize Socket.IO server
     * @param {Object} server - HTTP server instance
     * @returns {Object} Socket.IO instance
     */
    initialize(server) {
        if (this.io) {
            console.log('⚠️ Socket.IO already initialized');
            return this.io;
        }

        const socketIO = require('socket.io');

        console.log('\n🔌 ========== INITIALIZING SOCKET.IO ==========');

        this.io = socketIO(server, {
            cors: {
                origin: "*", // ⚠️ In production, specify your Flutter app's origin
                methods: ["GET", "POST"],
                credentials: true
            },
            pingTimeout: 60000,
            pingInterval: 25000,
            transports: ['websocket', 'polling']
        });

        this.setupConnectionHandlers();

        console.log('✅ Socket.IO initialized successfully');
        console.log('==========================================\n');

        return this.io;
    }

    /**
     * Setup connection event handlers
     */
    setupConnectionHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`\n🔌 ========== NEW CONNECTION ==========`);
            console.log(`👤 Client connected: ${socket.id}`);
            console.log(`📊 Total connections: ${this.io.engine.clientsCount}`);
            console.log(`========================================\n`);

            // ✅ Handle joining vehicle tracking room
            socket.on('joinVehicleTracking', (vehicleId) => {
                const room = `vehicle_${vehicleId}`;
                socket.join(room);

                // Track this client
                if (!this.connectedClients.has(vehicleId)) {
                    this.connectedClients.set(vehicleId, new Set());
                }
                this.connectedClients.get(vehicleId).add(socket.id);

                console.log(`✅ Socket ${socket.id} joined room: ${room}`);
                console.log(`👥 Total clients tracking vehicle ${vehicleId}: ${this.connectedClients.get(vehicleId).size}`);

                socket.emit('joinedRoom', {
                    success: true,
                    room: room,
                    vehicleId: vehicleId,
                    message: `Joined vehicle ${vehicleId} tracking`
                });
            });

            // ✅ Handle leaving vehicle tracking room
            socket.on('leaveVehicleTracking', (vehicleId) => {
                const room = `vehicle_${vehicleId}`;
                socket.leave(room);

                // Remove from tracking
                if (this.connectedClients.has(vehicleId)) {
                    this.connectedClients.get(vehicleId).delete(socket.id);
                    if (this.connectedClients.get(vehicleId).size === 0) {
                        this.connectedClients.delete(vehicleId);
                    }
                }

                console.log(`👋 Socket ${socket.id} left room: ${room}`);
                console.log(`👥 Remaining clients tracking vehicle ${vehicleId}: ${this.connectedClients.get(vehicleId)?.size || 0}`);
            });

            // ✅ Handle disconnection
            socket.on('disconnect', (reason) => {
                console.log(`\n❌ ========== DISCONNECTION ==========`);
                console.log(`👤 Client disconnected: ${socket.id}`);
                console.log(`📝 Reason: ${reason}`);

                // Clean up from all vehicle tracking
                this.connectedClients.forEach((clients, vehicleId) => {
                    if (clients.has(socket.id)) {
                        clients.delete(socket.id);
                        if (clients.size === 0) {
                            this.connectedClients.delete(vehicleId);
                        }
                        console.log(`🧹 Cleaned up socket ${socket.id} from vehicle ${vehicleId}`);
                    }
                });

                console.log(`📊 Total connections: ${this.io.engine.clientsCount}`);
                console.log(`========================================\n`);
            });
        });
    }

    /**
     * ✅ Emit real-time location update to all clients tracking a vehicle
     * @param {Number} vehicleId
     * @param {Object} locationData
     * @returns {Boolean}
     */
    emitLocationUpdate(vehicleId, locationData) {
        if (!this.io) {
            console.log('⚠️ Socket.IO not initialized, skipping location emission');
            return false;
        }

        const room = `vehicle_${vehicleId}`;
        const clientCount = this.connectedClients.get(vehicleId)?.size || 0;

        // Only emit if someone is watching
        if (clientCount === 0) {
            console.log(`⏭️ No clients tracking vehicle ${vehicleId}, skipping location emission`);
            return false;
        }

        const payload = {
            vehicleId: vehicleId,
            latitude: locationData.latitude,
            longitude: locationData.longitude,
            speed: locationData.speed || 0,
            engine_status: locationData.engine_status || 'UNKNOWN',
            car_model: locationData.car_model || null,
            timestamp: new Date().toISOString()
        };

        console.log(`\n📍 ========== EMITTING LOCATION UPDATE ==========`);
        console.log(`🚗 Vehicle ID: ${vehicleId}`);
        console.log(`📍 Room: ${room}`);
        console.log(`👥 Clients: ${clientCount}`);
        console.log(`📊 Lat: ${payload.latitude}, Lng: ${payload.longitude}`);
        console.log(`🏎️ Speed: ${payload.speed} km/h`);
        console.log(`🔧 Engine: ${payload.engine_status}`);

        this.io.to(room).emit('location_update', payload);

        console.log(`✅ Location update emitted successfully`);
        console.log(`==========================================\n`);

        return true;
    }

    /**
     * Emit GPS update (legacy method - kept for backward compatibility)
     * @param {Number} vehicleId
     * @param {Object} gpsData
     * @returns {Boolean}
     */
    emitGPSUpdate(vehicleId, gpsData) {
        if (!this.io) {
            console.log('⚠️ Socket.IO not initialized, skipping GPS emission');
            return false;
        }

        const room = `vehicle_${vehicleId}`;

        console.log(`\n📡 ========== EMITTING GPS UPDATE ==========`);
        console.log(`🚗 Vehicle ID: ${vehicleId}`);
        console.log(`📍 Room: ${room}`);
        console.log(`📊 Data:`, gpsData);

        this.io.to(room).emit('gpsUpdate', {
            vehicleId,
            latitude: gpsData.latitude,
            longitude: gpsData.longitude,
            speed: gpsData.speed,
            car_model: gpsData.car_model,
            timestamp: new Date().toISOString()
        });

        console.log(`✅ GPS update emitted to room: ${room}`);
        console.log(`========================================\n`);

        return true;
    }

    /**
     * Emit dashboard update
     * @param {Number} vehicleId
     * @param {Object} dashboardData
     * @returns {Boolean}
     */
    emitDashboardUpdate(vehicleId, dashboardData) {
        if (!this.io) {
            console.log('⚠️ Socket.IO not initialized, skipping dashboard emission');
            return false;
        }

        const room = `vehicle_${vehicleId}`;

        console.log(`📊 Emitting dashboard update to room: ${room}`);

        this.io.to(room).emit('dashboardUpdate', {
            vehicleId,
            speed: dashboardData.speed,
            gpsStatus: dashboardData.gpsStatus,
            vehicleStatus: dashboardData.vehicleStatus,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * ✅ Emit event to specific vehicle room (used for alerts, notifications, etc.)
     * @param {Number} vehicleId
     * @param {String} eventName
     * @param {Object} data
     * @returns {Boolean}
     */
    emitToVehicle(vehicleId, eventName, data) {
        if (!this.io) {
            console.log('⚠️ Socket.IO not initialized, skipping emission');
            return false;
        }

        const room = `vehicle_${vehicleId}`;
        const clientCount = this.connectedClients.get(vehicleId)?.size || 0;

        console.log(`\n🚨 ========== EMITTING EVENT ==========`);
        console.log(`🚗 Vehicle ID: ${vehicleId}`);
        console.log(`📍 Room: ${room}`);
        console.log(`📢 Event: ${eventName}`);
        console.log(`👥 Clients: ${clientCount}`);
        console.log(`📊 Data:`, JSON.stringify(data, null, 2));

        this.io.to(room).emit(eventName, data);

        console.log(`✅ Event '${eventName}' emitted to room: ${room}`);
        console.log(`==========================================\n`);

        return true;
    }

    /**
     * Get Socket.IO instance
     * @returns {Object}
     */
    getIO() {
        if (!this.io) {
            throw new Error('Socket.IO not initialized. Call initialize(server) first.');
        }
        return this.io;
    }

    /**
     * Check if Socket.IO is initialized
     * @returns {Boolean}
     */
    isInitialized() {
        return this.io !== null;
    }

    /**
     * Get number of clients tracking a specific vehicle
     * @param {Number} vehicleId
     * @returns {Number}
     */
    getClientCount(vehicleId) {
        return this.connectedClients.get(vehicleId)?.size || 0;
    }

    /**
     * Check if anyone is tracking a specific vehicle
     * @param {Number} vehicleId
     * @returns {Boolean}
     */
    isVehicleBeingTracked(vehicleId) {
        return this.connectedClients.has(vehicleId) && this.connectedClients.get(vehicleId).size > 0;
    }

    /**
     * Get all tracked vehicles
     * @returns {Array<Number>}
     */
    getTrackedVehicles() {
        return Array.from(this.connectedClients.keys());
    }


    getStats() {
        return {
            totalConnections: this.io ? this.io.engine.clientsCount : 0,
            trackedVehicles: this.connectedClients.size,
            vehicleDetails: Array.from(this.connectedClients.entries()).map(([vehicleId, clients]) => ({
                vehicleId,
                clientCount: clients.size
            }))
        };
    }
}

// Export singleton instance
module.exports = new SocketService();