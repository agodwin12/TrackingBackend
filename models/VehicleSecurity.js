const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VehicleSecurity = sequelize.define('VehicleSecurity', {
    voiture_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    parked_latitude: {
        type: DataTypes.DECIMAL(10, 8)
    },
    parked_longitude: {
        type: DataTypes.DECIMAL(11, 8)
    },
    activated_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'vehicle_security',
    timestamps: true
});

module.exports = VehicleSecurity;
