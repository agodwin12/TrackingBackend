// services/cacheInvalidationService.js
const cacheService = require("./cacheService");

class CacheInvalidationService {

    async invalidateVehicleLocation(vehicleId) {
        try {
            console.log(`\n🔄 ========== CACHE INVALIDATION ==========`);
            console.log(`🗑️ Invalidating cache for Vehicle ID: ${vehicleId}`);

            const cacheKey = `vehicle:${vehicleId}:location`;
            await cacheService.delete(cacheKey);

            console.log(`✅ Cache invalidated: ${cacheKey}`);
            console.log(`📝 Next request will fetch fresh data from DB`);
            console.log(`========== INVALIDATION COMPLETE ==========\n`);
        } catch (error) {
            console.error(`🔥 Cache invalidation error for vehicle ${vehicleId}:`, error.message);
            // Don't throw - invalidation failure shouldn't break the app
        }
    }


    async invalidateMultipleVehicles(vehicleIds) {
        try {
            console.log(`\n🔄 ========== BULK CACHE INVALIDATION ==========`);
            console.log(`🗑️ Invalidating cache for ${vehicleIds.length} vehicles`);

            const promises = vehicleIds.map(id => this.invalidateVehicleLocation(id));
            await Promise.all(promises);

            console.log(`✅ Bulk invalidation complete for ${vehicleIds.length} vehicles`);
            console.log(`========== BULK INVALIDATION COMPLETE ==========\n`);
        } catch (error) {
            console.error(`🔥 Bulk cache invalidation error:`, error.message);
        }
    }


    async invalidateAllVehicleData(vehicleId) {
        try {
            console.log(`\n🔄 ========== FULL VEHICLE CACHE CLEAR ==========`);
            console.log(`🗑️ Clearing ALL cache for Vehicle ID: ${vehicleId}`);

            const pattern = `vehicle:${vehicleId}:*`;
            await cacheService.deletePattern(pattern);

            console.log(`✅ All cache cleared for vehicle ${vehicleId}`);
            console.log(`========== FULL CLEAR COMPLETE ==========\n`);
        } catch (error) {
            console.error(`🔥 Full cache clear error for vehicle ${vehicleId}:`, error.message);
        }
    }


    async invalidateVehicleDetails(vehicleId, oldMacId = null, newMacId = null) {
        try {
            console.log(`\n🔄 ========== VEHICLE DETAILS UPDATE ==========`);
            console.log(`🗑️ Vehicle ${vehicleId} details changed`);
            if (oldMacId) console.log(`   Old MAC: ${oldMacId}`);
            if (newMacId) console.log(`   New MAC: ${newMacId}`);

            // Clear location cache (MAC changed, so old location data is invalid)
            await this.invalidateVehicleLocation(vehicleId);

            console.log(`✅ Vehicle details cache cleared`);
            console.log(`========== DETAILS UPDATE COMPLETE ==========\n`);
        } catch (error) {
            console.error(`🔥 Vehicle details cache clear error:`, error.message);
        }
    }


    async cleanupExpiredCache() {
        try {
            console.log(`\n🧹 ========== SCHEDULED CACHE CLEANUP ==========`);
            console.log(`🧹 Running cache cleanup...`);
            console.log(`ℹ️ Redis auto-expires keys, this is just a manual check`);

            // Redis handles TTL automatically, but you can add custom logic here
            // For example, cleanup cache for inactive vehicles

            console.log(`✅ Cleanup complete`);
            console.log(`========== CLEANUP COMPLETE ==========\n`);
        } catch (error) {
            console.error(`🔥 Cache cleanup error:`, error.message);
        }
    }
}

module.exports = new CacheInvalidationService();