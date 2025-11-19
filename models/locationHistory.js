// models/locationHistory.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LocationHistory = sequelize.define('LocationHistory', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    sys_time: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    user_name: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    longitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    datetime: {
        type: DataTypes.DATE,
        allowNull: true
    },
    heart_time: {
        type: DataTypes.DATE,
        allowNull: true
    },
    speed: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    status: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    direction: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    mac_id_gps: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'mac_id_gps'
    },
    archived_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'locations_history',
    timestamps: true,
    indexes: [
        {
            name: 'idx_history_mac_datetime',
            fields: ['mac_id_gps', 'datetime']
        },
        {
            name: 'idx_history_datetime',
            fields: ['datetime']
        },
        {
            name: 'idx_history_mac_systime',
            fields: ['mac_id_gps', 'sys_time']
        }
    ]
});

module.exports = LocationHistory;