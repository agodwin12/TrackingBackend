// models/sim_gps.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/sequelize"); // ✅ correct instance import

const SimGps = sequelize.define(
    "SimGps",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            primaryKey: true,
            autoIncrement: true,
        },
        objectid: {
            type: DataTypes.CHAR(36),
            allowNull: true,
        },
        account_name: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        mac_id: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },
        sim_number: {
            type: DataTypes.STRING(30),
            allowNull: true,
        },
    },
    {
        tableName: "sim_gps",
        timestamps: true,
        underscored: true, // created_at, updated_at
    }
);

module.exports = SimGps;
