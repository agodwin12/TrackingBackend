// models/User.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const User = sequelize.define("users", {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
    },
    user_unique_id: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    nom: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    prenom: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    phone: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    email: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
    },
    ville: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    quartier: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    photo: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    trip_tracking_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether trip tracking is enabled for this user',
    },
    speed_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'speed_alerts_enabled'
    },
    time_zone_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'time_zone_alerts_enabled'
    },
    battery_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
        comment: 'Enable/disable low battery alerts'
    },
    geofence_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether geofence alerts are enabled for this user',
    },
    safe_zone_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether safe zone alerts are enabled for this user',
    },
    is_first_login: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether user needs to change password on first login',
    },
    pin_hash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'User PIN for app lock (SHA-256 hashed, 4 digits)',
    },
    refresh_token: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: 'JWT refresh token for automatic token renewal'
    },
    refresh_token_expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Expiration date of the refresh token'
    },
}, {
    timestamps: false,
    tableName: 'users',
});

module.exports = User;