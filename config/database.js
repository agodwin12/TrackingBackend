// config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');
const logger        = require('../utils/logger');

// Hard-fail on missing credentials in production
if (process.env.NODE_ENV === 'production') {
    const required = ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        throw new Error(`❌ FATAL: Missing required database env vars: ${missing.join(', ')}`);
    }
}

const isProduction = process.env.NODE_ENV === 'developement';

const sequelize = new Sequelize(
    process.env.DB_NAME    ,
    process.env.DB_USER    ,
    process.env.DB_PASSWORD ,
    {
        host:    process.env.DB_HOST || 'localhost',
        port:    Number(process.env.DB_PORT) || 3306,
        dialect: 'mysql',

        // SQL logging via logger.debug — silent in production
        logging: isProduction
            ? false
            : (sql) => logger.debug(sql),

        define: {
            timestamps:  true,
            underscored: false,
        },

        // All pool values env-configurable for per-deployment tuning
        pool: {
            max:     Number(process.env.DB_POOL_MAX)     || 10,
            min:     Number(process.env.DB_POOL_MIN)     || 2,
            acquire: Number(process.env.DB_POOL_ACQUIRE) || 30000,
            idle:    Number(process.env.DB_POOL_IDLE)    || 10000,
        },

        dialectOptions: isProduction ? {
            ssl: { rejectUnauthorized: false }
        } : {},
    }
);

sequelize.authenticate()
    .then(() => logger.info('✅ Database connection established successfully'))
    .catch(err => logger.error('❌ Unable to connect to database:', err.message));

// Export sequelize instance only — CLI config lives in config/config.js
module.exports = sequelize;