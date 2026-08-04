// models/Command.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Command = sequelize.define('Command', {
    id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
    },
    user_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    },
    employe_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true
    },
    vehicule_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },
    CmdNo: {
        type: DataTypes.STRING(50),
        allowNull: false
    },
    status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'pending'
    },
    type_commande: {
        type: DataTypes.STRING(30),
        allowNull: true
    },
    trigger_source: {
        type: DataTypes.STRING(30),
        allowNull: true
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    trigger_alert_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true
    },
    speed_at_send: {
        type: DataTypes.DECIMAL(6, 2),
        allowNull: true
    },
    sent_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    provider_response: {
        type: DataTypes.JSON,
        allowNull: true
    },
    verified_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    verification_result: {
        type: DataTypes.STRING(30),
        allowNull: true
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: DataTypes.NOW
    },
    updated_at: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'commands',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Command;