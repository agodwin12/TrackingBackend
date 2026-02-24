// models/voiture.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Voiture = sequelize.define(
    "voitures",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },
        voiture_unique_id: {
            type: DataTypes.STRING(255),
            allowNull: false,
            unique: true,
            comment: 'Unique vehicle identifier',
        },
        immatriculation: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Vehicle registration/license plate',
        },
        mac_id_gps: {
            type: DataTypes.STRING(255),
            allowNull: false,
            unique: true,
            comment: 'GPS device MAC ID / IMEI',
        },
        marque: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Vehicle make/brand',
        },
        model: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Vehicle model',
        },
        couleur: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Vehicle color',
        },
        photo: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'Vehicle photo URL',
        },
        time_zone_start: {
            type: DataTypes.TIME,
            allowNull: true,
            comment: 'Time zone restriction start time',
        },
        time_zone_end: {
            type: DataTypes.TIME,
            allowNull: true,
            comment: 'Time zone restriction end time',
        },
        speed_zone: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Speed limit for this vehicle',
        },
        region_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: true,
            comment: 'Region ID',
        },
        region_name: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'Region name',
        },
        geofence_zone: {
            type: DataTypes.TEXT('long'),
            allowNull: true,
            comment: 'Geofence zone data (JSON or polygon)',
        },
        nickname: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'Vehicle nickname',
        },
        latitude: {
            type: DataTypes.DECIMAL(10, 8),
            allowNull: true,
            comment: 'Last known latitude',
        },
        longitude: {
            type: DataTypes.DECIMAL(11, 8),
            allowNull: true,
            comment: 'Last known longitude',
        },


        battery_level: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 0,
                max: 100
            },
            comment: 'Current battery level percentage (0-100)',
        },
        last_battery_check: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Timestamp of last battery level check',
        },
    },
    {
        tableName: "voitures",
        timestamps: true,
        underscored: true,
        createdAt: "created_at",
        updatedAt: "updated_at",
    }
);

module.exports = Voiture;