// services/cacheService.js
const redisClient = require("../config/redis");

class CacheService {

    async get(key) {
        try {
            const client = redisClient.getClient();
            const data = await client.get(key);

            if (data) {
                console.log(`🎯 Cache HIT: ${key}`);
                return JSON.parse(data);
            }

            console.log(`❌ Cache MISS: ${key}`);
            return null;
        } catch (error) {
            console.error(`🔥 Cache GET error for key ${key}:`, error.message);
            return null; // Fail gracefully, fetch from DB
        }
    }


    async set(key, value, ttl = 300) {
        try {
            const client = redisClient.getClient();
            await client.setex(key, ttl, JSON.stringify(value));
            console.log(`💾 Cache SET: ${key} (TTL: ${ttl}s)`);
        } catch (error) {
            console.error(`🔥 Cache SET error for key ${key}:`, error.message);
            // Don't throw - caching failure shouldn't break the app
        }
    }


    async delete(key) {
        try {
            const client = redisClient.getClient();
            await client.del(key);
            console.log(`🗑️ Cache DELETED: ${key}`);
        } catch (error) {
            console.error(`🔥 Cache DELETE error for key ${key}:`, error.message);
        }
    }


    async deletePattern(pattern) {
        try {
            const client = redisClient.getClient();
            const keys = await client.keys(pattern);

            if (keys.length > 0) {
                await client.del(...keys);
                console.log(`🗑️ Cache DELETED ${keys.length} keys matching: ${pattern}`);
            }
        } catch (error) {
            console.error(`🔥 Cache DELETE PATTERN error for ${pattern}:`, error.message);
        }
    }

    async flushAll() {
        try {
            const client = redisClient.getClient();
            await client.flushdb();
            console.log(`🧹 All cache CLEARED`);
        } catch (error) {
            console.error(`🔥 Cache FLUSH error:`, error.message);
        }
    }
}

module.exports = new CacheService();
