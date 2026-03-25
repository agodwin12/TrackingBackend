// services/geocodingService.js
//
// 💰 COST CONTROL: geocoding is disabled by default.
// To enable it, set  GEOCODING_ENABLED=true  in your .env file.
// With the flag absent or set to anything else, every function
// returns silently without making a single Google API call.

const axios  = require('axios');
const Trip   = require('../models/trip');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const GEOCODING_ENABLED    = process.env.GEOCODING_ENABLED === 'true';
const GOOGLE_MAPS_API_KEY  = process.env.GOOGLE_MAPS_API_KEY;
const GEOCODING_BATCH_SIZE = 10;
const GEOCODING_DELAY      = 200; // ms — 5 req/s max

if (!GEOCODING_ENABLED) {
    logger.info('🗺️  Geocoding is DISABLED (GEOCODING_ENABLED != true). No Google API calls will be made.');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isCoordinateAddress(address) {
    if (!address) return true;
    if (address.includes('°')) return true;
    if (address === 'Unknown location' || address === 'Geocoding...') return true;
    const parts = address.split(',');
    if (parts.length === 2 && parts.every(p => !isNaN(parseFloat(p.trim())))) return true;
    return false;
}

function formatSmartAddress(geocodingResult, latitude, longitude) {
    if (!geocodingResult?.results?.length) {
        return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
    }

    const { address_components = [], formatted_address } = geocodingResult.results[0];
    let route = '', neighborhood = '', locality = '', city = '';

    for (const c of address_components) {
        if (c.types.includes('route'))                                                        route        = c.long_name;
        if (c.types.includes('neighborhood') || c.types.includes('sublocality') ||
            c.types.includes('sublocality_level_1'))                                          neighborhood = c.long_name;
        if (c.types.includes('locality'))                                                     locality     = c.long_name;
        if (c.types.includes('administrative_area_level_2'))                                  city         = c.long_name;
    }

    if (route && locality)        return `${route}, ${locality}`;
    if (neighborhood && locality) return `${neighborhood}, ${locality}`;
    if (locality)                 return locality;
    if (city)                     return city;
    if (formatted_address)        return formatted_address;

    return `${parseFloat(latitude).toFixed(6)}°, ${parseFloat(longitude).toFixed(6)}°`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE GEOCODING — returns null immediately when disabled
// ─────────────────────────────────────────────────────────────────────────────

async function geocodeCoordinate(latitude, longitude) {
    if (!GEOCODING_ENABLED) return null;

    try {
        if (!GOOGLE_MAPS_API_KEY) {
            logger.warn('⚠️  GOOGLE_MAPS_API_KEY is missing');
            return null;
        }

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            logger.warn(`⚠️  Invalid coordinates: ${lat}, ${lng}`);
            return null;
        }

        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: { latlng: `${lat},${lng}`, key: GOOGLE_MAPS_API_KEY, language: 'en' },
            timeout: 7000,
        });

        if (response.data.status !== 'OK') {
            logger.warn(`⚠️  Geocoding failed: ${response.data.status} for ${lat}, ${lng}`);
            return null;
        }

        return response.data;

    } catch (error) {
        logger.error('🔥 Geocoding error:', error.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH WORKER
// ─────────────────────────────────────────────────────────────────────────────

async function processPendingGeocoding() {
    if (!GEOCODING_ENABLED) return { processed: 0, success: 0, failed: 0 };

    try {
        const trips = await Trip.findAll({
            where: {
                [Op.or]: [
                    { start_address: null },
                    { end_address:   null },
                    { start_address: { [Op.like]: '%°%' } },
                    { end_address:   { [Op.like]: '%°%' } },
                    { start_address: 'Unknown location' },
                    { end_address:   'Unknown location' },
                    { start_address: 'Geocoding...' },
                    { end_address:   'Geocoding...' },
                ],
            },
            limit: GEOCODING_BATCH_SIZE,
            order: [['created_at', 'DESC']],
        });

        if (trips.length === 0) return { processed: 0, success: 0, failed: 0 };

        logger.info(`📍 Geocoding ${trips.length} trip(s)...`);

        let successCount = 0;
        let failCount    = 0;

        for (const trip of trips) {
            try {
                let updated = false;

                if (isCoordinateAddress(trip.start_address)) {
                    const result = await geocodeCoordinate(trip.start_latitude, trip.start_longitude);
                    if (result) {
                        const addr = formatSmartAddress(result, trip.start_latitude, trip.start_longitude);
                        if (!isCoordinateAddress(addr)) { trip.start_address = addr; updated = true; }
                    }
                    await delay(GEOCODING_DELAY);
                }

                if (isCoordinateAddress(trip.end_address)) {
                    const result = await geocodeCoordinate(trip.end_latitude, trip.end_longitude);
                    if (result) {
                        const addr = formatSmartAddress(result, trip.end_latitude, trip.end_longitude);
                        if (!isCoordinateAddress(addr)) { trip.end_address = addr; updated = true; }
                    }
                    await delay(GEOCODING_DELAY);
                }

                if (updated) { await trip.save(); successCount++; }
                else         { failCount++; }

            } catch (err) {
                logger.error(`🔥 Error geocoding trip ${trip.id}:`, err.message);
                failCount++;
            }
        }

        logger.info(`✅ Geocoding batch done: ${successCount} ok, ${failCount} failed`);
        return { processed: trips.length, success: successCount, failed: failCount };

    } catch (error) {
        logger.error('🔥 Fatal error in geocoding batch:', error.message);
        return { processed: 0, success: 0, failed: 0 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE TRIP
// ─────────────────────────────────────────────────────────────────────────────

async function geocodeTrip(tripId) {
    if (!GEOCODING_ENABLED) return false;

    try {
        const trip = await Trip.findByPk(tripId);
        if (!trip) return false;

        let updated = false;

        if (isCoordinateAddress(trip.start_address)) {
            const result = await geocodeCoordinate(trip.start_latitude, trip.start_longitude);
            if (result) {
                const addr = formatSmartAddress(result, trip.start_latitude, trip.start_longitude);
                if (!isCoordinateAddress(addr)) { trip.start_address = addr; updated = true; }
            }
            await delay(GEOCODING_DELAY);
        }

        if (isCoordinateAddress(trip.end_address)) {
            const result = await geocodeCoordinate(trip.end_latitude, trip.end_longitude);
            if (result) {
                const addr = formatSmartAddress(result, trip.end_latitude, trip.end_longitude);
                if (!isCoordinateAddress(addr)) { trip.end_address = addr; updated = true; }
            }
        }

        if (updated) await trip.save();
        return updated;

    } catch (error) {
        logger.error(`🔥 Error geocoding trip ${tripId}:`, error.message);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND WORKER — starts regardless; is a no-op when disabled
// ─────────────────────────────────────────────────────────────────────────────

function startGeocodingWorker() {
    if (!GEOCODING_ENABLED) {
        logger.info('🗺️  Geocoding worker is off (GEOCODING_ENABLED != true).');
        return;
    }

    logger.info('🗺️  Geocoding background worker started (every 5 min).');
    processPendingGeocoding();
    setInterval(processPendingGeocoding, 5 * 60 * 1000);
}

module.exports = {
    geocodeCoordinate,
    formatSmartAddress,
    processPendingGeocoding,
    geocodeTrip,
    startGeocodingWorker,
    isCoordinateAddress,
};