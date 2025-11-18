// backend/models/DeviceToken.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const User = require("./userModel");

const DeviceToken = sequelize.define("device_tokens", {
    id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
    },
    user_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
    },
    token: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: true,
    },
    device_type: {
        type: DataTypes.ENUM('android', 'ios', 'web'),
        allowNull: false,
        defaultValue: 'android',
    },
    device_id: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
    },
    last_used_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
});

// Define relationships
DeviceToken.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

User.hasMany(DeviceToken, {
    foreignKey: 'user_id',
    as: 'device_tokens'
});

module.exports = DeviceToken;