// models/subscriptionPlan.js
'use strict';
const { DataTypes } = require('sequelize');
const sequelize     = require('../config/database');

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
        // e.g. 'MONTHLY' | 'YEARLY' | 'PER_VEHICLE'
    },

    label: {
        type:      DataTypes.STRING,
        allowNull: false,
    },


    billing_mode: {
        type:         DataTypes.ENUM('DAY', 'MONTH'),
        allowNull:    false,
        defaultValue: 'DAY',
    },

    // Used when billing_mode = 'DAY'
    duration_days: {
        type:      DataTypes.INTEGER,
        allowNull: true,
    },

    // Used when billing_mode = 'MONTH'
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