const axios = require("axios");

/**
 * 🗺️ REVERSE GEOCODING SERVICE (Google Maps)
 * Converts GPS coordinates to human-readable addresses
 */

class GeocodingService {

    static GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    static GOOGLE_BASE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

    static initialize() {
        if (!this.GOOGLE_API_KEY) {
            throw new Error('GOOGLE_MAPS_API_KEY is not set in environment variables');
        }
        console.log('✅ Google Maps Geocoding Service initialized');
    }


    // Cache to avoid repeated API calls for same location
    static cache = new Map();
    static MAX_CACHE_SIZE = 1000; // Prevent memory issues

    /**
     * Convert latitude/longitude to address using Google Maps
     *
     * @param {number} latitude
     * @param {number} longitude
     * @returns {Promise<string>} Formatted address
     */
    static async getAddress(latitude, longitude) {
        try {
            // Round coordinates to reduce cache misses (0.001 ≈ 111 meters)
            const lat = parseFloat(latitude).toFixed(3);
            const lon = parseFloat(longitude).toFixed(3);
            const cacheKey = `${lat},${lon}`;

            // Check cache first
            if (this.cache.has(cacheKey)) {
                console.log(`📍 Cache hit for ${cacheKey}`);
                return this.cache.get(cacheKey);
            }

            console.log(`🔍 Reverse geocoding: ${lat}, ${lon}`);

            // Call Google Maps Geocoding API
            const response = await axios.get(this.GOOGLE_BASE_URL, {
                params: {
                    latlng: `${latitude},${longitude}`,
                    key: this.GOOGLE_API_KEY,
                    language: 'fr', // French for Cameroon, change to 'en' if needed
                    result_type: 'street_address|route|neighborhood|locality|sublocality'
                },
                timeout: 5000 // 5 second timeout
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                // Format address nicely
                const address = this.formatGoogleAddress(response.data.results);

                // Cache the result (with size limit)
                if (this.cache.size >= this.MAX_CACHE_SIZE) {
                    // Remove oldest entry
                    const firstKey = this.cache.keys().next().value;
                    this.cache.delete(firstKey);
                }
                this.cache.set(cacheKey, address);

                console.log(`✅ Address found: ${address}`);
                return address;
            } else {
                console.warn(`⚠️  No address found: ${response.data.status}`);
                return this.formatCoordinates(latitude, longitude);
            }

        } catch (error) {
            console.error(`❌ Geocoding error for ${latitude}, ${longitude}:`, error.message);

            // Return formatted coordinates as fallback
            return this.formatCoordinates(latitude, longitude);
        }
    }

    /**
     * Format Google Maps API response into a nice address
     * Prioritizes more specific results
     */
    static formatGoogleAddress(results) {
        // Try to find the most specific address
        for (const result of results) {
            const types = result.types;

            // Prefer street addresses
            if (types.includes('street_address') || types.includes('route')) {
                return this.parseGoogleComponents(result.address_components);
            }
        }

        // Fall back to first result
        if (results.length > 0) {
            return this.parseGoogleComponents(results[0].address_components);
        }

        return 'Unknown Location';
    }

    /**
     * Parse Google address components into readable format
     * Format: "Street, Neighborhood, City"
     */
    static parseGoogleComponents(components) {
        const address = {
            street: null,
            neighborhood: null,
            sublocality: null,
            locality: null,
            administrative: null
        };

        for (const component of components) {
            const types = component.types;

            if (types.includes('route')) {
                address.street = component.long_name;
            } else if (types.includes('neighborhood')) {
                address.neighborhood = component.long_name;
            } else if (types.includes('sublocality') || types.includes('sublocality_level_1')) {
                address.sublocality = component.long_name;
            } else if (types.includes('locality')) {
                address.locality = component.long_name;
            } else if (types.includes('administrative_area_level_2')) {
                address.administrative = component.long_name;
            }
        }

        // Build address string (most specific to least specific)
        const parts = [];

        if (address.street) parts.push(address.street);
        if (address.neighborhood) parts.push(address.neighborhood);
        if (address.sublocality && address.sublocality !== address.neighborhood) {
            parts.push(address.sublocality);
        }
        if (address.locality) parts.push(address.locality);

        return parts.length > 0 ? parts.join(", ") : 'Location inconnue';
    }

    /**
     * Format coordinates as fallback
     */
    static formatCoordinates(latitude, longitude) {
        return `${parseFloat(latitude).toFixed(4)}°, ${parseFloat(longitude).toFixed(4)}°`;
    }

    /**
     * Batch geocoding - get multiple addresses at once
     * Useful for processing multiple trips
     */
    static async getAddressBatch(locations) {
        const promises = locations.map(loc =>
            this.getAddress(loc.latitude, loc.longitude)
        );
        return await Promise.all(promises);
    }

    /**
     * Clear cache (call periodically to prevent memory issues)
     */
    static clearCache() {
        this.cache.clear();
        console.log('🗑️  Geocoding cache cleared');
    }

    /**
     * Get cache statistics
     */
    static getCacheStats() {
        return {
            size: this.cache.size,
            maxSize: this.MAX_CACHE_SIZE
        };
    }
}

module.exports = GeocodingService;