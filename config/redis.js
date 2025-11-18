// config/redis.js
const Redis = require("ioredis");

class RedisClient {
    constructor() {
        this.client = null;
        this.isConnected = false;
    }

    connect() {
        try {
            this.client = new Redis({
                host: process.env.REDIS_HOST || "localhost",
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD || undefined,
                db: process.env.REDIS_DB || 0,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: 3,
            });

            this.client.on("connect", () => {
                console.log("✅ Redis connected successfully");
                this.isConnected = true;
            });

            this.client.on("error", (err) => {
                console.error("❌ Redis connection error:", err.message);
                this.isConnected = false;
            });

            this.client.on("close", () => {
                console.log("⚠️ Redis connection closed");
                this.isConnected = false;
            });

            return this.client;
        } catch (error) {
            console.error("🔥 Failed to initialize Redis:", error.message);
            throw error;
        }
    }

    getClient() {
        if (!this.client) {
            throw new Error("Redis client not initialized. Call connect() first.");
        }
        return this.client;
    }

    async disconnect() {
        if (this.client) {
            await this.client.quit();
            console.log("👋 Redis disconnected");
        }
    }
}

// Singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;