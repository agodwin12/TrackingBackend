const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VehicleSecurity = sequelize.define('VehicleSecurity', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    voiture_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },
    is_active: {
        type: DataTypes.TINYINT,
        defaultValue: 0,
        allowNull: true
    },
    parked_latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    parked_longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true
    },
    activated_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'vehicle_security',
    timestamps: true,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
});

module.exports = VehicleSecurity;