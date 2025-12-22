// utils/logger.js
const isProduction = process.env.NODE_ENV === 'production';

const logger = {
    debug: (...args) => {
        if (!isProduction) {
            console.log('🔍', ...args);
        }
    },

    info: (...args) => {
        console.log('ℹ️', ...args);
    },

    warn: (...args) => {
        console.warn('⚠️', ...args);
    },

    error: (...args) => {
        console.error('🔥', ...args);
    },

    success: (...args) => {
        console.log('✅', ...args);
    }
};

module.exports = logger;