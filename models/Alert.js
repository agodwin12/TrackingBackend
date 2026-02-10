// models/alert.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Alert = sequelize.define("alerts", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    voiture_id: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: false,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },
    alert_type: {
        type: DataTypes.ENUM(
            'geofence',
            'safe_zone',
            'speed',
            'engine',
            'general',
            'stolen',
            'time_zone',
            'low_battery',           // Battery below threshold
            'battery_recovery',      // Battery recovering above threshold
            'power_failure',         // Power failure alarm (0x23)
            'offline',               // Device offline alarm (0x25)
            'device_removal',        // Device removal alarm (0x26)
            'disconnection',         // 🆕 GPS disconnection (0x1F)
            'device_unplugged',      // 🆕 Device physically unplugged (0x5B)
            'connection_loss'        // 🆕 Communication loss (0x43)
        ),
        allowNull: false,
        defaultValue: 'general'
    },
    alert_subtype: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Alert subtype for additional categorization',
    },
    message: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    alerted_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    sent: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    processed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether alert has been processed',
    },
    processed_by: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        comment: 'User ID who processed the alert',
        references: {
            model: 'users',
            key: 'id'
        }
    },
    latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
        comment: 'Location latitude when alert was created',
    },
    longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
        comment: 'Location longitude when alert was created',
    },
    alert_status: {
        type: DataTypes.ENUM('ACTIVE', 'RESOLVED', 'FALSE_ALARM'),
        allowNull: true,
        comment: 'Status for critical alerts',
    },

    // Metadata field for storing additional alert information
    metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Additional alert metadata (battery_level, threshold, severity, direction, etc.)',
    },
}, {
    tableName: "alerts",
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Alert;