// models/userModel.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const User = sequelize.define("users", {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
    },
    role_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
        defaultValue: 4,
        comment: 'Role of the user (FK to roles table)',
    },
    partner_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        defaultValue: null,
        comment: 'Partner this user belongs to. NULL = regular user',
    },
    created_by: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        defaultValue: null,
        comment: 'ID of the user who created this account',
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
    country_code: {
        type: DataTypes.CHAR(2),
        allowNull: true,
        defaultValue: 'CM',
        comment: 'ISO 3166-1 alpha-2 country code (e.g. CM, NG, CI, US)',
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
    photo: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    email_verified_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    remember_token: {
        type: DataTypes.STRING(100),
        allowNull: true,
    },
    trip_tracking_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether trip tracking is enabled for this user',
    },
    is_first_login: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: true,
        comment: 'Whether user needs to change password on first login',
    },
    pin_hash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'SHA-256 hash of the user PIN',
    },
    geofence_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    safe_zone_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    battery_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: true,
    },
    speed_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    time_zone_alerts_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    refresh_token: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: 'Keycloak refresh token stored for logout/revocation',
    },
    refresh_token_expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Expiration date of the Keycloak refresh token',
    },
    // ── Keycloak integration ──────────────────────────────────────────────────
    keycloak_id: {
        type: DataTypes.STRING(36),
        allowNull: true,
        unique: true,
        comment: 'Keycloak user UUID (sub claim). Populated on first Keycloak login.',
    },
}, {
    timestamps: true,
    tableName: 'users',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
});

module.exports = User;