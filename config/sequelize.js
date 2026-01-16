// config/sequelize.js
const { Sequelize } = require("sequelize");

// Create one global instance of Sequelize (make sure DB credentials are correct)
const sequelize = new Sequelize(
    process.env.DB_NAME || "trackingdb",
    process.env.DB_USER || "root",
    process.env.DB_PASS || "",
    {
        host: process.env.DB_HOST || "127.0.0.1",
        dialect: "mysql",
        logging: false,
        define: {
            timestamps: false,
        },
    }
);

module.exports = sequelize;
