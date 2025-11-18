const cron = require("node-cron");
const TripDetectionService = require("../services/tripDetectionService");



class TripDetectionCron {

    static start() {
        console.log("🕐 Starting Trip Detection Cron Job...");
        console.log("📅 Schedule: Every 1 minutes");

        // Run every 30 minutes
        cron.schedule("*/1 * * * *", async () => {
            console.log("\n⏰ Cron job triggered...");

            try {
                await TripDetectionService.detectAndCreateTrips();
            } catch (error) {
                console.error("❌ Cron job failed:", error);
            }
        });

        console.log("✅ Cron job scheduled successfully\n");
    }

    /**
     * Manual trigger for testing
     */
    static async runManually() {
        console.log("🔧 Running trip detection manually...");
        try {
            const result = await TripDetectionService.detectAndCreateTrips();
            console.log("✅ Manual run completed:", result);
            return result;
        } catch (error) {
            console.error("❌ Manual run failed:", error);
            throw error;
        }
    }
}

module.exports = TripDetectionCron;