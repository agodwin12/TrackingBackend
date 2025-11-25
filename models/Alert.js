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
        type: DataTypes.ENUM('geofence', 'safe_zone', 'speed', 'engine', 'general', 'stolen'), // 🆕 Added 'stolen'
        allowNull: false,
        defaultValue: 'general'
    },
    message: {
        type: DataTypes.STRING,
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
    // 🆕 Additional fields for stolen alerts
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
        comment: 'Status for stolen/critical alerts',
    },
}, {
    tableName: "alerts",
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Alert;