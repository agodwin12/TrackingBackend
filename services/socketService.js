// services/socketService.js
const logger = require('../utils/logger');

class SocketService {
    constructor() {
        this.io              = null;
        this.connectedClients = new Map();
        logger.info('🔌 SocketService instance created');
    }

    /**
     * Initialize Socket.IO service with the already-configured io instance
     * from server.js. We accept the instance rather than creating a new one
     * so that the CORS / transport config defined in server.js is the single
     * source of truth — no duplicate instantiation, no wildcard origin bypass.
     *
     * @param {import('socket.io').Server} io - The Socket.IO Server created in server.js
     * @returns {import('socket.io').Server}
     */
    initialize(io) {
        if (this.io) {
            logger.warn('⚠️ Socket.IO already initialized');
            return this.io;
        }

        // ✅ FIXED: accept the io instance that was created (and CORS-configured)
        // in server.js instead of spawning a second one with origin: "*"
        this.io = io;

        this.setupConnectionHandlers();

        logger.info('✅ Socket.IO service initialized');

        return this.io;
    }

    // ==================== CONNECTION HANDLERS ====================

    setupConnectionHandlers() {
        this.io.on('connection', (socket) => {
            logger.info(`🔌 Client connected: ${socket.id} | total: ${this.io.engine.clientsCount}`);

            socket.on('joinVehicleTracking', (vehicleId) => {
                // Basic input guard — vehicleId must be a usable value
                if (vehicleId === undefined || vehicleId === null) {
                    socket.emit('error', { message: 'vehicleId is required' });
                    return;
                }

                const room = `vehicle_${vehicleId}`;
                socket.join(room);

                if (!this.connectedClients.has(vehicleId)) {
                    this.connectedClients.set(vehicleId, new Set());
                }
                this.connectedClients.get(vehicleId).add(socket.id);

                logger.info(`✅ Socket ${socket.id} joined room: ${room} | clients: ${this.connectedClients.get(vehicleId).size}`);

                socket.emit('joinedRoom', {
                    success:   true,
                    room:      room,
                    vehicleId: vehicleId,
                    message:   `Joined vehicle ${vehicleId} tracking`
                });
            });

            socket.on('leaveVehicleTracking', (vehicleId) => {
                const room = `vehicle_${vehicleId}`;
                socket.leave(room);

                if (this.connectedClients.has(vehicleId)) {
                    this.connectedClients.get(vehicleId).delete(socket.id);
                    if (this.connectedClients.get(vehicleId).size === 0) {
                        this.connectedClients.delete(vehicleId);
                    }
                }

                logger.info(`👋 Socket ${socket.id} left room: ${room} | remaining: ${this.connectedClients.get(vehicleId)?.size || 0}`);
            });

            // ── USER ROOM — for payment updates and user-level notifications ──────
            // Flutter emits joinUserRoom with the logged-in user's ID right after
            // connecting. This lets the backend push payment_update events directly
            // to the user without going through a vehicle room.
            socket.on('joinUserRoom', (userId) => {
                if (userId === undefined || userId === null) {
                    socket.emit('error', { message: 'userId is required' });
                    return;
                }

                const room = `user_${userId}`;
                socket.join(room);

                logger.info(`✅ Socket ${socket.id} joined user room: ${room}`);

                socket.emit('joinedUserRoom', {
                    success: true,
                    room:    room,
                    userId:  userId,
                });
            });
            // ─────────────────────────────────────────────────────────────────────

            socket.on('disconnect', (reason) => {
                logger.info(`❌ Client disconnected: ${socket.id} | reason: ${reason}`);

                // Clean up from every vehicle room this socket was in
                this.connectedClients.forEach((clients, vehicleId) => {
                    if (clients.has(socket.id)) {
                        clients.delete(socket.id);
                        if (clients.size === 0) {
                            this.connectedClients.delete(vehicleId);
                        }
                        logger.info(`🧹 Removed socket ${socket.id} from vehicle ${vehicleId}`);
                    }
                });

                logger.info(`📊 Total connections after disconnect: ${this.io.engine.clientsCount}`);
            });
        });
    }

    // ==================== EMIT HELPERS ====================

    /**
     * Emit real-time location update to all clients tracking a vehicle.
     * Skips emission silently when nobody is watching (saves bandwidth).
     */
    emitLocationUpdate(vehicleId, locationData) {
        if (!this.io) {
            logger.warn('⚠️ Socket.IO not initialized — skipping location emission');
            return false;
        }

        const clientCount = this.connectedClients.get(vehicleId)?.size || 0;

        if (clientCount === 0) {
            return false; // nobody watching, no need to emit
        }

        const payload = {
            vehicleId:     vehicleId,
            latitude:      locationData.latitude,
            longitude:     locationData.longitude,
            speed:         locationData.speed         || 0,
            engine_status: locationData.engine_status || 'UNKNOWN',
            car_model:     locationData.car_model     || null,
            timestamp:     new Date().toISOString()
        };

        this.io.to(`vehicle_${vehicleId}`).emit('location_update', payload);

        logger.debug(
            `📍 location_update → vehicle ${vehicleId} | ` +
            `[${payload.latitude}, ${payload.longitude}] | ` +
            `${payload.speed} km/h | ${payload.engine_status} | ` +
            `${clientCount} client(s)`
        );

        return true;
    }

    /**
     * Emit GPS update (legacy — kept for backward compatibility).
     */
    emitGPSUpdate(vehicleId, gpsData) {
        if (!this.io) {
            logger.warn('⚠️ Socket.IO not initialized — skipping GPS emission');
            return false;
        }

        this.io.to(`vehicle_${vehicleId}`).emit('gpsUpdate', {
            vehicleId,
            latitude:  gpsData.latitude,
            longitude: gpsData.longitude,
            speed:     gpsData.speed,
            car_model: gpsData.car_model,
            timestamp: new Date().toISOString()
        });

        logger.debug(`📡 gpsUpdate → vehicle ${vehicleId}`);
        return true;
    }

    /**
     * Emit dashboard update.
     */
    emitDashboardUpdate(vehicleId, dashboardData) {
        if (!this.io) {
            logger.warn('⚠️ Socket.IO not initialized — skipping dashboard emission');
            return false;
        }

        this.io.to(`vehicle_${vehicleId}`).emit('dashboardUpdate', {
            vehicleId,
            speed:         dashboardData.speed,
            gpsStatus:     dashboardData.gpsStatus,
            vehicleStatus: dashboardData.vehicleStatus,
            timestamp:     new Date().toISOString()
        });

        logger.debug(`📊 dashboardUpdate → vehicle ${vehicleId}`);
        return true;
    }

    /**
     * Emit a named event to a specific vehicle room (alerts, notifications, etc.).
     */
    emitToVehicle(vehicleId, eventName, data) {
        if (!this.io) {
            logger.warn('⚠️ Socket.IO not initialized — skipping emission');
            return false;
        }

        const clientCount = this.connectedClients.get(vehicleId)?.size || 0;

        this.io.to(`vehicle_${vehicleId}`).emit(eventName, data);

        logger.info(`🚨 '${eventName}' → vehicle ${vehicleId} | ${clientCount} client(s)`);
        return true;
    }

    /**
     * Emit payment update to a specific user room.
     * Called by paygateWebhook after the webhook confirms SUCCESS or FAILED.
     * Flutter's PaymentPendingScreen listens for 'payment_update' and reacts.
     *
     * @param {number} userId
     * @param {'SUCCESS'|'FAILED'} status
     * @param {number} paymentId
     * @param {number} vehicleId
     */
    emitPaymentUpdate(userId, status, paymentId, vehicleId) {
        if (!this.io) {
            logger.warn('⚠️ Socket.IO not initialized — skipping payment emission');
            return false;
        }

        const payload = {
            status,
            payment_id: paymentId,
            vehicle_id: vehicleId,
            timestamp:  new Date().toISOString(),
        };

        this.io.to(`user_${userId}`).emit('payment_update', payload);

        logger.info(
            `💳 payment_update → user_${userId} | ` +
            `status=${status} | payment=${paymentId} | vehicle=${vehicleId}`
        );

        return true;
    }

    // ==================== INTROSPECTION ====================

    getIO() {
        if (!this.io) {
            throw new Error('Socket.IO not initialized. Call initialize(io) first.');
        }
        return this.io;
    }

    isInitialized() {
        return this.io !== null;
    }

    getClientCount(vehicleId) {
        return this.connectedClients.get(vehicleId)?.size || 0;
    }

    isVehicleBeingTracked(vehicleId) {
        return this.connectedClients.has(vehicleId) &&
            this.connectedClients.get(vehicleId).size > 0;
    }

    getTrackedVehicles() {
        return Array.from(this.connectedClients.keys());
    }

    getStats() {
        return {
            totalConnections: this.io ? this.io.engine.clientsCount : 0,
            trackedVehicles:  this.connectedClients.size,
            vehicleDetails:   Array.from(this.connectedClients.entries()).map(
                ([vehicleId, clients]) => ({ vehicleId, clientCount: clients.size })
            )
        };
    }
}

module.exports = new SocketService();