// services/geocodingService.js - SIMPLIFIED (No new columns needed)
const axios = require("axios");
const Trip = require("../models/trip");
const { Op } = require("sequelize");
const logger = require("../utils/logger");

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GEOCODING_BATCH_SIZE = 10; // Process 10 trips at a time
const GEOCODING_DELAY = 200; // 200ms delay between requests (5 requests/second)

/**
 * Smart address formatter
 * Priority: Street > City > Coordinates
 */
function formatSmartAddress(geocodingResult, latitude, longitude) {
    if (!geocodingResult || !geocodingResult.results || geocodingResult.results.length === 0) {
        return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
    }

    const result = geocodingResult.results[0];
    const addressComponents = result.address_components || [];

    let route = '';
    let neighborhood = '';
    let locality = '';
    let city = '';

    for (const component of addressComponents) {
        if (component.types.includes('route')) {
            route = component.long_name;
        }
        if (component.types.includes('neighborhood') ||
            component.types.includes('sublocality') ||
            component.types.includes('sublocality_level_1')) {
            neighborhood = component.long_name;
        }
        if (component.types.includes('locality')) {
            locality = component.long_name;
        }
        if (component.types.includes('administrative_area_level_2')) {
            city = component.long_name;
        }
    }

    // Priority 1: Street + City
    if (route && locality) {
        return `${route}, ${locality}`;
    }

    // Priority 2: Neighborhood + City
    if (neighborhood && locality) {
        return `${neighborhood}, ${locality}`;
    }

    // Priority 3: City only
    if (locality) {
        return locality;
    }

    // Priority 4: District/Region
    if (city) {
        return city;
    }

    // Priority 5: Formatted address (fallback)
    if (result.formatted_address) {
        return result.formatted_address;
    }

    // Priority 6: Coordinates
    return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
}

/**
 * Geocode a single coordinate using Google Maps API
 */
async function geocodeCoordinate(latitude, longitude) {
    try {
        if (!GOOGLE_MAPS_API_KEY) {
            logger.warn("⚠️ GOOGLE_MAPS_API_KEY is missing");
            return null;
        }

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            logger.warn(`⚠️ Invalid coordinates: ${lat}, ${lng}`);
            return null;
        }

        const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
            params: {
                latlng: `${lat},${lng}`,
                key: GOOGLE_MAPS_API_KEY,
                language: "en",
            },
            timeout: 7000,
        });

        if (response.data.status !== "OK") {
            logger.warn(`⚠️ Geocoding failed: ${response.data.status} for ${lat}, ${lng}`);
            return null;
        }

        return response.data;

    } catch (error) {
        logger.error(`🔥 Geocoding error:`, error.message);
        return null;
    }
}

/**
 * Check if address needs geocoding
 * (Detects if address is coordinates)
 */
function isCoordinateAddress(address) {
    if (!address) return true;

    // Check if it contains degree symbol
    if (address.includes('°')) return true;

    // Check if it's in format "number, number"
    const parts = address.split(',');
    if (parts.length === 2) {
        const isNumbers = parts.every(p => !isNaN(parseFloat(p.trim())));
        if (isNumbers) return true;
    }

    // Check for common placeholder values
    if (address === 'Unknown location' || address === 'Geocoding...') {
        return true;
    }

    return false;
}

/**
 * Process pending geocoding for trips
 * ✅ Uses ONLY existing columns (no new columns needed)
 */
async function processPendingGeocoding() {
    try {
        logger.info("🗺️ Starting geocoding batch process...");

        // Find trips where addresses look like coordinates
        const trips = await Trip.findAll({
            where: {
                [Op.or]: [
                    { start_address: null },
                    { end_address: null },
                    { start_address: { [Op.like]: '%°%' } },
                    { end_address: { [Op.like]: '%°%' } },
                    { start_address: 'Unknown location' },
                    { end_address: 'Unknown location' },
                    { start_address: 'Geocoding...' },
                    { end_address: 'Geocoding...' }
                ]
            },
            limit: GEOCODING_BATCH_SIZE,
            order: [['created_at', 'DESC']]
        });

        if (trips.length === 0) {
            logger.info("✅ No trips pending geocoding");
            return { processed: 0, success: 0, failed: 0 };
        }

        logger.info(`📍 Found ${trips.length} trips needing geocoding`);

        let successCount = 0;
        let failCount = 0;

        for (const trip of trips) {
            try {
                let updated = false;

                // Geocode start location if needed
                if (isCoordinateAddress(trip.start_address)) {
                    logger.debug(`🗺️ Geocoding start location for trip ${trip.id}`);

                    const geocodeResult = await geocodeCoordinate(trip.start_latitude, trip.start_longitude);

                    if (geocodeResult) {
                        const newAddress = formatSmartAddress(geocodeResult, trip.start_latitude, trip.start_longitude);

                        // Only update if it's actually better than what we have
                        if (!isCoordinateAddress(newAddress)) {
                            trip.start_address = newAddress;
                            updated = true;
                            logger.info(`✅ Start geocoded: ${newAddress}`);
                        }
                    } else {
                        logger.warn(`⚠️ Start geocoding failed for trip ${trip.id}`);
                    }

                    // Rate limiting delay
                    await delay(GEOCODING_DELAY);
                }

                // Geocode end location if needed
                if (isCoordinateAddress(trip.end_address)) {
                    logger.debug(`🗺️ Geocoding end location for trip ${trip.id}`);

                    const geocodeResult = await geocodeCoordinate(trip.end_latitude, trip.end_longitude);

                    if (geocodeResult) {
                        const newAddress = formatSmartAddress(geocodeResult, trip.end_latitude, trip.end_longitude);

                        // Only update if it's actually better than what we have
                        if (!isCoordinateAddress(newAddress)) {
                            trip.end_address = newAddress;
                            updated = true;
                            logger.info(`✅ End geocoded: ${newAddress}`);
                        }
                    } else {
                        logger.warn(`⚠️ End geocoding failed for trip ${trip.id}`);
                    }

                    // Rate limiting delay
                    await delay(GEOCODING_DELAY);
                }

                if (updated) {
                    await trip.save();
                    successCount++;
                } else {
                    failCount++;
                }

            } catch (error) {
                logger.error(`🔥 Error geocoding trip ${trip.id}:`, error.message);
                failCount++;
            }
        }

        logger.info(`✅ Geocoding batch complete: ${successCount} success, ${failCount} failed`);

        return {
            processed: trips.length,
            success: successCount,
            failed: failCount
        };

    } catch (error) {
        logger.error("🔥 Fatal error in geocoding batch:", error);
        return { processed: 0, success: 0, failed: 0 };
    }
}

/**
 * Geocode a specific trip immediately
 */
async function geocodeTrip(tripId) {
    try {
        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            logger.warn(`⚠️ Trip ${tripId} not found`);
            return false;
        }

        logger.info(`🗺️ Geocoding trip ${tripId}...`);

        let updated = false;

        // Start location
        if (isCoordinateAddress(trip.start_address)) {
            const geocodeResult = await geocodeCoordinate(trip.start_latitude, trip.start_longitude);

            if (geocodeResult) {
                const newAddress = formatSmartAddress(geocodeResult, trip.start_latitude, trip.start_longitude);
                if (!isCoordinateAddress(newAddress)) {
                    trip.start_address = newAddress;
                    updated = true;
                    logger.info(`✅ Start: ${newAddress}`);
                }
            }

            await delay(GEOCODING_DELAY);
        }

        // End location
        if (isCoordinateAddress(trip.end_address)) {
            const geocodeResult = await geocodeCoordinate(trip.end_latitude, trip.end_longitude);

            if (geocodeResult) {
                const newAddress = formatSmartAddress(geocodeResult, trip.end_latitude, trip.end_longitude);
                if (!isCoordinateAddress(newAddress)) {
                    trip.end_address = newAddress;
                    updated = true;
                    logger.info(`✅ End: ${newAddress}`);
                }
            }
        }

        if (updated) {
            await trip.save();
            logger.info(`✅ Trip ${tripId} geocoded successfully`);
            return true;
        }

        return false;

    } catch (error) {
        logger.error(`🔥 Error geocoding trip ${tripId}:`, error);
        return false;
    }
}

/**
 * Utility delay function
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Start background geocoding worker (runs every 5 minutes)
 */
function startGeocodingWorker() {
    logger.info("🗺️ Starting geocoding background worker...");

    // Run immediately on startup
    processPendingGeocoding();

    // Then run every 5 minutes
    setInterval(async () => {
        await processPendingGeocoding();
    }, 5 * 60 * 1000); // 5 minutes
}

module.exports = {
    geocodeCoordinate,
    formatSmartAddress,
    processPendingGeocoding,
    geocodeTrip,
    startGeocodingWorker,
    isCoordinateAddress
};