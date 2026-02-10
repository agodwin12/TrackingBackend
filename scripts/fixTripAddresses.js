// scripts/fixTripAddresses.js - Fix existing trips with coordinates
const geocodingService = require('../services/geocodingService');
const logger = require('../utils/logger');

/**
 * Run this script to fix all existing trips that have coordinates instead of addresses
 *
 * Usage: node scripts/fixTripAddresses.js
 */

async function fixAllTripAddresses() {
    try {
        logger.info("===========================================");
        logger.info("🗺️ FIXING TRIP ADDRESSES - STARTED");
        logger.info("===========================================");

        let totalProcessed = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let batchNumber = 0;

        // Process in batches until no more trips need geocoding
        while (true) {
            batchNumber++;
            logger.info(`\n📦 Processing batch ${batchNumber}...`);

            const result = await geocodingService.processPendingGeocoding();

            totalProcessed += result.processed;
            totalSuccess += result.success;
            totalFailed += result.failed;

            logger.info(`📊 Batch ${batchNumber} complete: ${result.success} success, ${result.failed} failed`);

            // If no trips were processed, we're done
            if (result.processed === 0) {
                logger.info("\n✅ No more trips to process");
                break;
            }

            // Wait 1 second between batches to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        logger.info("\n===========================================");
        logger.info("✅ FIXING TRIP ADDRESSES - COMPLETE");
        logger.info("===========================================");
        logger.info(`📊 Total processed: ${totalProcessed}`);
        logger.info(`✅ Success: ${totalSuccess}`);
        logger.info(`❌ Failed: ${totalFailed}`);
        logger.info("===========================================\n");

        process.exit(0);

    } catch (error) {
        logger.error("🔥 Fatal error:", error);
        process.exit(1);
    }
}

// Run the script
fixAllTripAddresses();