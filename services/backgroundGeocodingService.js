// services/backgroundGeocodingService.js - FIXED TO USE created_at
const Trip = require("../models/trip");
const GeocodingService = require("./geocodingService");
const logger = require("../utils/logger");
const { Op } = require("sequelize");

class BackgroundGeocodingService {
    // ==================== CONFIGURATION ====================

    static BATCH_SIZE = 10; // Process 10 addresses at a time
    static MAX_RETRIES = 3; // Retry failed geocoding 3 times
    static RETRY_DELAY_MINUTES = 5; // Wait 5 minutes before retrying
    static GEOCODING_TIMEOUT_MS = 5000; // 5 second timeout per address
    static PROCESSING_INTERVAL_SECONDS = 30; // Run every 30 seconds

    static isRunning = false;
    static processingInterval = null;
    static stats = {
        totalProcessed: 0,
        successCount: 0,
        failedCount: 0,
        lastRunTime: null
    };

    // Track last attempt time for each trip (in memory)
    static lastAttemptTimes = new Map();

    // ==================== MAIN PROCESSING ====================

    /**
     * Start background geocoding service
     */
    static start() {
        if (this.isRunning) {
            logger.warn("⚠️ Background geocoding service already running");
            return;
        }

        logger.info("🚀 Starting background geocoding service...");
        this.isRunning = true;

        // Run immediately on start
        this.processPendingAddresses();

        // Then run periodically
        this.processingInterval = setInterval(() => {
            this.processPendingAddresses();
        }, this.PROCESSING_INTERVAL_SECONDS * 1000);

        logger.info(`✅ Background geocoding service started (interval: ${this.PROCESSING_INTERVAL_SECONDS}s)`);
    }

    /**
     * Stop background geocoding service
     */
    static stop() {
        if (!this.isRunning) {
            logger.warn("⚠️ Background geocoding service not running");
            return;
        }

        logger.info("🛑 Stopping background geocoding service...");

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        this.isRunning = false;
        this.lastAttemptTimes.clear();
        logger.info("✅ Background geocoding service stopped");
    }

    /**
     * Get service statistics
     */
    static getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            intervalSeconds: this.PROCESSING_INTERVAL_SECONDS
        };
    }

    /**
     * Process pending addresses in background
     */
    static async processPendingAddresses() {
        if (!this.isRunning) return;

        try {
            logger.debug("🔍 Checking for trips with pending addresses...");

            // Find trips with pending addresses
            const pendingTrips = await Trip.findAll({
                where: {
                    [Op.or]: [
                        { start_address_status: 'pending' },
                        { end_address_status: 'pending' },
                        {
                            start_address_status: 'failed',
                            start_address_retry_count: { [Op.lt]: this.MAX_RETRIES }
                        },
                        {
                            end_address_status: 'failed',
                            end_address_retry_count: { [Op.lt]: this.MAX_RETRIES }
                        }
                    ]
                },
                attributes: [
                    'id',
                    'start_latitude',
                    'start_longitude',
                    'start_address',
                    'start_address_status',
                    'start_address_retry_count',
                    'end_latitude',
                    'end_longitude',
                    'end_address',
                    'end_address_status',
                    'end_address_retry_count',
                    'created_at'
                ],
                limit: this.BATCH_SIZE,
                order: [['created_at', 'ASC']] // Process oldest first
            });

            if (pendingTrips.length === 0) {
                logger.debug("✅ No pending addresses to geocode");
                this.stats.lastRunTime = new Date();
                return;
            }

            logger.info(`📍 Found ${pendingTrips.length} trips with pending addresses`);

            let successCount = 0;
            let failedCount = 0;

            for (const trip of pendingTrips) {
                const tripId = trip.id;

                // Check if we should retry failed addresses
                const shouldRetryStart = this.shouldRetry(
                    tripId,
                    'start',
                    trip.start_address_status,
                    trip.start_address_retry_count
                );

                const shouldRetryEnd = this.shouldRetry(
                    tripId,
                    'end',
                    trip.end_address_status,
                    trip.end_address_retry_count
                );

                // Process start address
                if (trip.start_address_status === 'pending' || shouldRetryStart) {
                    const result = await this.geocodeAddress(
                        tripId,
                        trip.start_latitude,
                        trip.start_longitude,
                        'start',
                        trip.start_address_retry_count || 0
                    );

                    if (result.success) {
                        successCount++;
                    } else {
                        failedCount++;
                    }
                }

                // Process end address
                if (trip.end_address_status === 'pending' || shouldRetryEnd) {
                    const result = await this.geocodeAddress(
                        tripId,
                        trip.end_latitude,
                        trip.end_longitude,
                        'end',
                        trip.end_address_retry_count || 0
                    );

                    if (result.success) {
                        successCount++;
                    } else {
                        failedCount++;
                    }
                }

                // Small delay between trips to avoid rate limiting
                await this.sleep(200);
            }

            this.stats.totalProcessed += successCount + failedCount;
            this.stats.successCount += successCount;
            this.stats.failedCount += failedCount;
            this.stats.lastRunTime = new Date();

            logger.info(`✅ Geocoding batch complete: ${successCount} success, ${failedCount} failed`);

        } catch (error) {
            logger.error("🔥 Error in background geocoding:", error);
        }
    }

    /**
     * Geocode a single address with retry logic
     */
    static async geocodeAddress(tripId, latitude, longitude, type, retryCount = 0) {
        try {
            logger.debug(`📍 Geocoding ${type} address for trip ${tripId} (attempt ${retryCount + 1}/${this.MAX_RETRIES})`);

            // Record attempt time
            this.lastAttemptTimes.set(`${tripId}-${type}`, Date.now());

            // Geocode with timeout
            const address = await Promise.race([
                GeocodingService.getAddress(latitude, longitude),
                new Promise((resolve, reject) =>
                    setTimeout(() => reject(new Error('Geocoding timeout')), this.GEOCODING_TIMEOUT_MS)
                )
            ]);

            if (!address || address === "Unknown location" || address.includes("Error")) {
                throw new Error('Invalid geocoding result');
            }

            // Update trip with geocoded address
            const updateData = {};
            updateData[`${type}_address`] = address;
            updateData[`${type}_address_status`] = 'geocoded';
            updateData[`${type}_address_retry_count`] = 0; // Reset retry count on success

            await Trip.update(updateData, {
                where: { id: tripId }
            });

            logger.info(`✅ Geocoded ${type} address for trip ${tripId}: ${address}`);

            return { success: true, address };

        } catch (error) {
            logger.warn(`⚠️ Failed to geocode ${type} address for trip ${tripId}:`, error.message);

            // Update retry count and status
            const newRetryCount = retryCount + 1;
            const updateData = {};
            updateData[`${type}_address_retry_count`] = newRetryCount;

            if (newRetryCount >= this.MAX_RETRIES) {
                // Max retries reached - mark as failed and set coordinates as fallback
                const fallbackAddress = `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
                updateData[`${type}_address`] = fallbackAddress;
                updateData[`${type}_address_status`] = 'failed';
                logger.error(`❌ Max retries reached for trip ${tripId} ${type} address - using coordinates: ${fallbackAddress}`);
            } else {
                // Will retry later
                updateData[`${type}_address_status`] = 'failed';
                logger.debug(`🔄 Will retry geocoding ${type} address for trip ${tripId} (${newRetryCount}/${this.MAX_RETRIES})`);
            }

            await Trip.update(updateData, {
                where: { id: tripId }
            });

            return { success: false, error: error.message };
        }
    }

    /**
     * Determine if we should retry a failed geocoding attempt
     * Uses in-memory tracking of last attempt time
     */
    static shouldRetry(tripId, type, status, retryCount = 0) {
        if (status !== 'failed') return false;
        if (retryCount >= this.MAX_RETRIES) return false;

        // Check if enough time has passed since last attempt
        const lastAttemptKey = `${tripId}-${type}`;
        const lastAttempt = this.lastAttemptTimes.get(lastAttemptKey);

        if (!lastAttempt) {
            // No record of last attempt, allow retry
            return true;
        }

        const timeSinceLastAttempt = (Date.now() - lastAttempt) / (1000 * 60); // minutes
        return timeSinceLastAttempt >= this.RETRY_DELAY_MINUTES;
    }

    /**
     * Manually trigger geocoding for a specific trip
     * Useful for API endpoints to force immediate geocoding
     */
    static async geocodeTripAddresses(tripId) {
        try {
            logger.info(`📍 Manually triggering geocoding for trip ${tripId}`);

            const trip = await Trip.findByPk(tripId, {
                attributes: [
                    'id',
                    'start_latitude',
                    'start_longitude',
                    'start_address_status',
                    'start_address_retry_count',
                    'end_latitude',
                    'end_longitude',
                    'end_address_status',
                    'end_address_retry_count'
                ]
            });

            if (!trip) {
                logger.warn(`⚠️ Trip ${tripId} not found`);
                return { success: false, error: 'Trip not found' };
            }

            const results = {
                tripId,
                startAddress: null,
                endAddress: null,
                errors: []
            };

            // Geocode start address if needed
            if (trip.start_address_status === 'pending' || trip.start_address_status === 'failed') {
                const startResult = await this.geocodeAddress(
                    trip.id,
                    trip.start_latitude,
                    trip.start_longitude,
                    'start',
                    trip.start_address_retry_count || 0
                );

                if (startResult.success) {
                    results.startAddress = startResult.address;
                } else {
                    results.errors.push(`Start: ${startResult.error}`);
                }
            } else {
                results.startAddress = 'Already geocoded';
            }

            // Geocode end address if needed
            if (trip.end_address_status === 'pending' || trip.end_address_status === 'failed') {
                const endResult = await this.geocodeAddress(
                    trip.id,
                    trip.end_latitude,
                    trip.end_longitude,
                    'end',
                    trip.end_address_retry_count || 0
                );

                if (endResult.success) {
                    results.endAddress = endResult.address;
                } else {
                    results.errors.push(`End: ${endResult.error}`);
                }
            } else {
                results.endAddress = 'Already geocoded';
            }

            const success = results.errors.length === 0;
            logger.info(`${success ? '✅' : '⚠️'} Manual geocoding for trip ${tripId}: ${success ? 'success' : 'partial success'}`);

            return {
                success,
                data: results
            };

        } catch (error) {
            logger.error(`🔥 Error in manual geocoding for trip ${tripId}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Reprocess all failed addresses
     */
    static async reprocessFailedAddresses() {
        try {
            logger.info("🔄 Reprocessing all failed addresses...");

            // Reset failed addresses to pending for retry
            const result = await Trip.update({
                start_address_status: 'pending',
                start_address_retry_count: 0
            }, {
                where: {
                    start_address_status: 'failed',
                    start_address_retry_count: { [Op.gte]: this.MAX_RETRIES }
                }
            });

            const result2 = await Trip.update({
                end_address_status: 'pending',
                end_address_retry_count: 0
            }, {
                where: {
                    end_address_status: 'failed',
                    end_address_retry_count: { [Op.gte]: this.MAX_RETRIES }
                }
            });

            const totalReset = (result[0] || 0) + (result2[0] || 0);

            // Clear retry tracking
            this.lastAttemptTimes.clear();

            logger.info(`✅ Reset ${totalReset} failed addresses for reprocessing`);

            // Trigger immediate processing
            await this.processPendingAddresses();

            return {
                success: true,
                addressesReset: totalReset
            };

        } catch (error) {
            logger.error("🔥 Error reprocessing failed addresses:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get pending addresses count
     */
    static async getPendingCount() {
        try {
            const startPending = await Trip.count({
                where: {
                    [Op.or]: [
                        { start_address_status: 'pending' },
                        { start_address_status: 'failed' }
                    ]
                }
            });

            const endPending = await Trip.count({
                where: {
                    [Op.or]: [
                        { end_address_status: 'pending' },
                        { end_address_status: 'failed' }
                    ]
                }
            });

            return {
                startAddresses: startPending,
                endAddresses: endPending,
                total: startPending + endPending
            };

        } catch (error) {
            logger.error("🔥 Error getting pending count:", error);
            return { startAddresses: 0, endAddresses: 0, total: 0 };
        }
    }

    /**
     * Utility: Sleep function
     */
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BackgroundGeocodingService;