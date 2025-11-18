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
    alert_type: {  // ✅ NEW FIELD
        type: DataTypes.ENUM('geofence', 'safe_zone', 'speed', 'engine', 'general'),
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
}, {
    tableName: "alerts",
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Alert;