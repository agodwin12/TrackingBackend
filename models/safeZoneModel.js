// models/safeZoneModel.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SafeZone = sequelize.define('SafeZone', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    user_id: {
        type: DataTypes.BIGINT,
        allowNull: false
        // Removed references - let associations handle it
    },
    vehicle_id: {
        type: DataTypes.BIGINT,
        allowNull: false
        // Removed references - let associations handle it
    },
    name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: 'Safe Zone'
    },
    center_latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: false
    },
    center_longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: false
    },
    radius_meters: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    alert_triggered: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    last_alert_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'safe_zones',
    timestamps: true,
    underscored: true,
    charset: 'utf8mb4',  // Add this to match your other tables
    collate: 'utf8mb4_general_ci',  // Add this to match your other tables
    indexes: [
        {
            fields: ['user_id']
        },
        {
            fields: ['vehicle_id']
        },
        {
            fields: ['is_active']
        }
    ]
});

module.exports = SafeZone;