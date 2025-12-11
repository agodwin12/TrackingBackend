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
    // Trip tracking preference
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
    // ✅ NEW: Geofence alerts preference
    geofence_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether geofence alerts are enabled for this user',
    },
    // ✅ NEW: Safe zone alerts preference
    safe_zone_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether safe zone alerts are enabled for this user',
    },
    // First login tracking
    is_first_login: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether user needs to change password on first login',
    },
    // PIN for app lock (hashed with SHA-256)
    pin_hash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'User PIN for app lock (SHA-256 hashed, 4 digits)',
    },
}, {
    timestamps: false,
    tableName: 'users',
});

module.exports = User;