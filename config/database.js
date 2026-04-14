const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD ?? '';
const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.DB_PORT) || 3306;

const isProduction = process.env.NODE_ENV === 'production';

// Hard-fail if required env vars are missing
const required = ['DB_NAME', 'DB_USER', 'DB_HOST'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
    throw new Error(`❌ Missing required database env vars: ${missing.join(', ')}`);
}

logger.info(`[DB] Using database="${dbName}" host="${dbHost}" user="${dbUser}"`);

const sequelize = new Sequelize(dbName, dbUser, dbPassword, {
    host: dbHost,
    port: dbPort,
    dialect: 'mysql',

    logging: isProduction ? false : (sql) => logger.debug(sql),

    define: {
        timestamps: true,
        underscored: false,
    },

    pool: {
        max: Number(process.env.DB_POOL_MAX) || 10,
        min: Number(process.env.DB_POOL_MIN) || 2,
        acquire: Number(process.env.DB_POOL_ACQUIRE) || 30000,
        idle: Number(process.env.DB_POOL_IDLE) || 10000,
    },

    dialectOptions: isProduction
        ? {
            ssl: { rejectUnauthorized: true },
        }
        : {},
});

sequelize
    .authenticate()
    .then(() => logger.info('✅ Database connection established successfully'))
    .catch((err) => logger.error('❌ Unable to connect to database:', err.message));

module.exports = sequelize;