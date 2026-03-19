'use strict';
const { DataTypes } = require('sequelize');
const sequelize     = require('../config/database');

const VALID_FEATURES = [
    'live_tracking',
    'geofence',
    'safe_zone',
    'trip_history',
    'engine_control',
    'report_stolen',
];

const SubscriptionPlan = sequelize.define('SubscriptionPlan', {
    id: {
        type:          DataTypes.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
    },

    code: {
        type:      DataTypes.STRING,
        allowNull: false,
        unique:    true,
    },

    label: {
        type:      DataTypes.STRING,
        allowNull: false,
    },

    billing_mode: {
        type:         DataTypes.ENUM('MONTH'),
        allowNull:    false,
        defaultValue: 'MONTH',
    },

    duration_months: {
        type:      DataTypes.INTEGER,
        allowNull: true,
    },

    price: {
        type:      DataTypes.DECIMAL(10, 2),
        allowNull: false,
    },

    currency: {
        type:         DataTypes.STRING(10),
        allowNull:    false,
        defaultValue: 'XAF',
    },


    features: {
        type:         DataTypes.STRING, // raw string — Sequelize has no native SET type
        allowNull:    false,
        defaultValue: '',
        comment:      " live_tracking','geofence','safe_zone','trip_history','engine_control','report_stolen",
    },

    is_active: {
        type:         DataTypes.BOOLEAN,
        allowNull:    false,
        defaultValue: true,
    },
}, {
    tableName:  'subscription_plans',
    timestamps: true,
    createdAt:  'created_at',
    updatedAt:  'updated_at',
});

module.exports = SubscriptionPlan;
module.exports.VALID_FEATURES = VALID_FEATURES;