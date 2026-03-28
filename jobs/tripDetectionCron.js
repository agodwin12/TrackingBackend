// cron/tripDetectionCron.js
const cron = require("node-cron");
const TripDetectionService = require("../services/tripDetectionService");
const logger = require("../utils/logger");

// ─── Overlap guard ────────────────────────────────────────────────────────────
// Prevents a new detection run from starting while the previous one is still
// running. Without this, a slow run (many vehicles / large backlog) causes
// multiple concurrent runs that race over the same unprocessed locations,
// producing duplicate trips and DB deadlocks.
let isRunning = false;

// ─── Concurrency cap ──────────────────────────────────────────────────────────
// How many vehicles to process in parallel. Keeps DB load predictable.
// Override with TRIP_DETECTION_CONCURRENCY in .env if needed.
const CONCURRENCY = Number(process.env.TRIP_DETECTION_CONCURRENCY ?? 5);

/**
 * Process an array of MAC IDs with a concurrency cap.
 * Uses Promise.allSettled so one failing vehicle never blocks the others.
 */
async function processVehiclesConcurrently(macs) {
    const results   = [];
    const executing = [];

    for (const mac of macs) {
        const task = TripDetectionService.processVehicleLocations(mac)
            .then(res  => ({ mac, status: "fulfilled", value: res }))
            .catch(err => ({ mac, status: "rejected",  reason: err.message }));

        results.push(task);
        executing.push(task);

        // Once we have CONCURRENCY tasks in flight, wait for the fastest one
        // to finish before launching the next
        if (executing.length >= CONCURRENCY) {
            await Promise.race(executing);
            // Remove settled tasks from the in-flight list
            for (let i = executing.length - 1; i >= 0; i--) {
                const state = await Promise.race([
                    executing[i].then(() => "done").catch(() => "done"),
                    Promise.resolve("pending")
                ]);
                if (state === "done") executing.splice(i, 1);
            }
        }
    }

    // Wait for any remaining in-flight tasks
    return Promise.allSettled(results);
}

class TripDetectionCron {

    static start() {
        logger.info("🕐 Trip Detection Cron starting — schedule: every 1 minute");

        // Runs every minute — correct for 15-second GPS intervals
        cron.schedule("*/1 * * * *", async () => {

            // ── Overlap guard ─────────────────────────────────────────────────
            if (isRunning) {
                logger.warn("[TRIP CRON] Previous run still in progress — skipping this tick");
                return;
            }

            isRunning = true;
            const startedAt = Date.now();
            logger.info("[TRIP CRON] ⏰ Tick started");

            try {
                // ── Fetch vehicles that have unprocessed GPS data ─────────────
                const macs = await TripDetectionService.getVehiclesWithUnprocessedData();

                if (macs.length === 0) {
                    logger.debug("[TRIP CRON] No vehicles with unprocessed data — idle");
                    return;
                }

                logger.info(`[TRIP CRON] ${macs.length} vehicle(s) to process (concurrency cap: ${CONCURRENCY})`);

                // ── Process all vehicles concurrently (capped) ────────────────
                const settled = await processVehiclesConcurrently(macs);

                // ── Summarise results ─────────────────────────────────────────
                let totalTrips  = 0;
                let totalMerged = 0;
                let skipped     = 0;
                let errors      = 0;

                for (const outcome of settled) {
                    // Each item is itself a Promise wrapping { mac, status, value/reason }
                    const item = await outcome;

                    if (item.status === "rejected") {
                        errors++;
                        logger.error(`[TRIP CRON] Vehicle ${item.mac} failed: ${item.reason}`);
                        continue;
                    }

                    const res = item.value;
                    if (res.skipped)       skipped++;
                    if (res.tripsCreated)  totalTrips  += res.tripsCreated;
                    if (res.tripsMerged)   totalMerged += res.tripsMerged;
                }

                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

                logger.info(
                    `[TRIP CRON] ✅ Tick complete in ${elapsed}s` +
                    ` | vehicles: ${macs.length}` +
                    ` | trips created: ${totalTrips}` +
                    ` | trips merged: ${totalMerged}` +
                    ` | skipped: ${skipped}` +
                    ` | errors: ${errors}`
                );

            } catch (error) {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                logger.error(`[TRIP CRON] ❌ Fatal error after ${elapsed}s: ${error.message}`, error.stack);
            } finally {
                // ── Always release the lock, even on error ────────────────────
                isRunning = false;
            }
        });

        logger.info("✅ Trip Detection Cron scheduled successfully");
    }

    /**
     * Manual trigger — useful for testing from a REST endpoint or CLI.
     * Respects the same overlap guard as the scheduled run.
     */
    static async runManually() {
        if (isRunning) {
            logger.warn("[TRIP CRON] Manual trigger ignored — a run is already in progress");
            return { success: false, reason: "Already running" };
        }

        isRunning = true;
        const startedAt = Date.now();
        logger.info("[TRIP CRON] 🔧 Manual run started");

        try {
            const macs = await TripDetectionService.getVehiclesWithUnprocessedData();

            if (macs.length === 0) {
                logger.info("[TRIP CRON] Manual run: no unprocessed data found");
                return { success: true, tripsCreated: 0, vehiclesProcessed: 0 };
            }

            logger.info(`[TRIP CRON] Manual run: ${macs.length} vehicle(s) to process`);

            const settled = await processVehiclesConcurrently(macs);

            let totalTrips  = 0;
            let totalMerged = 0;
            let skipped     = 0;
            let errors      = 0;

            for (const outcome of settled) {
                const item = await outcome;

                if (item.status === "rejected") {
                    errors++;
                    logger.error(`[TRIP CRON] Manual run — vehicle ${item.mac} failed: ${item.reason}`);
                    continue;
                }

                const res = item.value;
                if (res.skipped)       skipped++;
                if (res.tripsCreated)  totalTrips  += res.tripsCreated;
                if (res.tripsMerged)   totalMerged += res.tripsMerged;
            }

            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            const result  = {
                success:           true,
                elapsedSeconds:    parseFloat(elapsed),
                vehiclesProcessed: macs.length - skipped,
                vehiclesSkipped:   skipped,
                tripsCreated:      totalTrips,
                tripsMerged:       totalMerged,
                errors
            };

            logger.info(`[TRIP CRON] ✅ Manual run complete in ${elapsed}s`, result);
            return result;

        } catch (error) {
            logger.error(`[TRIP CRON] ❌ Manual run failed: ${error.message}`, error.stack);
            throw error;
        } finally {
            isRunning = false;
        }
    }
}

module.exports = TripDetectionCron;