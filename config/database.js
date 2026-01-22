// config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

// ✅ Create Sequelize instance
const sequelize = new Sequelize(
    process.env.DB_NAME || 'tracking',
    process.env.DB_USER || 'root',
    process.env.DB_PASSWORD || 'Proxym2024!',
    {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 3306,
        dialect: 'mysql',
        logging: console.log, // Shows SQL queries in console (set to false in production)
        define: {
            timestamps: true,
            underscored: false,
        },
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }
);

// ✅ Test connection
sequelize.authenticate()
    .then(() => {
        console.log('✅ Database connection established successfully');
    })
    .catch(err => {
        console.error('❌ Unable to connect to database:', err.message);
    });

// ✅ Export for use in models and server
module.exports = sequelize;

// ✅ Also export config for Sequelize CLI (migrations)
module.exports.development = {
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tracking',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: console.log,
};

module.exports.production = {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
};