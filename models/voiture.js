// models/voiture.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Voiture = sequelize.define("voitures", {
    id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true
    },
    voiture_unique_id: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    immatriculation: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    mac_id_gps: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    marque: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    model: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    couleur: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    photo: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    time_zone_start: {
        type: DataTypes.TIME,
        allowNull: true
    },
    time_zone_end: {
        type: DataTypes.TIME,
        allowNull: true
    },
    speed_zone: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    region_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true
    },
    region_name: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    updated_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true
    },
    geofence_zone: {
        type: DataTypes.TEXT('long'),
        allowNull: true
    },
    geofence_latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    geofence_longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true
    },
    geofence_radius: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    nickname: {
        type: DataTypes.STRING(255),
        allowNull: true
    }
}, {
    timestamps: false,
    tableName: 'voitures'
});

module.exports = Voiture;