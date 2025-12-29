// config/redis.js - Redis Client Configuration (ioredis) - FIXED
const Redis = require('ioredis');
const logger = require('../utils/logger');

class RedisClient {
    constructor() {
        this.client = null;
        this.isConnected = false;
    }

    /**
     * Connect to Redis
     */
    connect() {
        try {
            logger.info('🔄 Initializing Redis connection...');

            this.client = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT) || 6379,
                password: process.env.REDIS_PASSWORD || undefined,
                db: parseInt(process.env.REDIS_DB) || 0,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                lazyConnect: false,
            });

            this.client.on('connect', () => {
                logger.info('🔄 Redis connecting...');
            });

            this.client.on('ready', () => {
                logger.info('✅ Redis connected and ready');
                this.isConnected = true;
            });

            this.client.on('error', (err) => {
                logger.error('❌ Redis error:', err.message);
                this.isConnected = false;
            });

            this.client.on('close', () => {
                logger.warn('⚠️ Redis connection closed');
                this.isConnected = false;
            });

            this.client.on('reconnecting', () => {
                logger.info('🔄 Redis reconnecting...');
            });

        } catch (error) {
            logger.error('🔥 Failed to initialize Redis:', error.message);
            this.isConnected = false;
        }
    }

    /**
     * GET - Retrieve value by key
     */
    async get(key) {
        if (!this.client || !this.isConnected) {
            logger.debug('⚠️ Redis not connected, skipping GET');
            return null;
        }

        try {
            return await this.client.get(key);
        } catch (error) {
            logger.error(`🔥 Redis GET error for key ${key}:`, error.message);
            return null;
        }
    }

    /**
     * SET with expiration (ioredis uses lowercase 'setex')
     */
    async setEx(key, seconds, value) {
        if (!this.client || !this.isConnected) {
            logger.debug('⚠️ Redis not connected, skipping SET');
            return;
        }

        try {
            return await this.client.setex(key, seconds, value);
        } catch (error) {
            logger.error(`🔥 Redis SETEX error for key ${key}:`, error.message);
        }
    }

    /**
     * SET without expiration
     */
    async set(key, value) {
        if (!this.client || !this.isConnected) {
            logger.debug('⚠️ Redis not connected, skipping SET');
            return;
        }

        try {
            return await this.client.set(key, value);
        } catch (error) {
            logger.error(`🔥 Redis SET error for key ${key}:`, error.message);
        }
    }

    /**
     * DEL - Delete keys
     */
    async del(...keys) {
        if (!this.client || !this.isConnected) {
            logger.debug('⚠️ Redis not connected, skipping DEL');
            return 0;
        }

        try {
            if (keys.length === 0) return 0;
            return await this.client.del(...keys);
        } catch (error) {
            logger.error(`🔥 Redis DEL error:`, error.message);
            return 0;
        }
    }

    /**
     * KEYS - Find keys by pattern
     */
    async keys(pattern) {
        if (!this.client || !this.isConnected) {
            logger.debug('⚠️ Redis not connected, skipping KEYS');
            return [];
        }

        try {
            return await this.client.keys(pattern);
        } catch (error) {
            logger.error(`🔥 Redis KEYS error:`, error.message);
            return [];
        }
    }

    /**
     * EXISTS - Check if key exists
     */
    async exists(key) {
        if (!this.client || !this.isConnected) {
            return 0;
        }

        try {
            return await this.client.exists(key);
        } catch (error) {
            logger.error(`🔥 Redis EXISTS error:`, error.message);
            return 0;
        }
    }

    /**
     * Disconnect from Redis
     */
    async disconnect() {
        if (this.client && this.isConnected) {
            try {
                await this.client.quit();
                this.isConnected = false;
                logger.info('✅ Redis disconnected gracefully');
            } catch (error) {
                logger.error('❌ Error disconnecting Redis:', error.message);
                this.client.disconnect();
            }
        }
    }
}

// Create singleton instance
const redisClient = new RedisClient();

redisClient.connect();

module.exports = redisClient;