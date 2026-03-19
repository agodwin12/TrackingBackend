// config/sequelize.js
const { Sequelize } = require("sequelize");

// Create one global instance of Sequelize (make sure DB credentials are correct)
const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host: process.env.DB_HOST ,
        dialect: "mysql",
        logging: false,
        define: {
            timestamps: false,
        },
    }
);

module.exports = sequelize;
