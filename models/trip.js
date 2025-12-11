const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Trip = sequelize.define("trips", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    vehicle_id: {
        type: DataTypes.BIGINT.UNSIGNED, // <-- must match voitures.id
        allowNull: false,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },

    mac_id_gps: {
        type: DataTypes.STRING,
        allowNull: false
    },

    // Trip timing
    start_time: {
        type: DataTypes.DATE,
        allowNull: false
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: false
    },
    duration_minutes: {
        type: DataTypes.INTEGER,
        allowNull: false
    },

    // Start location
    start_latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: false
    },
    start_longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: false
    },
    start_address: {
        type: DataTypes.STRING(500),
        allowNull: true
    },

    // End location
    end_latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: false
    },
    end_longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: false
    },
    end_address: {
        type: DataTypes.STRING(500),
        allowNull: true
    },

    // Trip metrics
    total_distance_km: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    avg_speed_kmh: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    max_speed_kmh: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('ongoing', 'completed'),
        allowNull: false,
        defaultValue: 'completed'
    },
    // Metadata
    waypoint_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    timestamps: false,
    indexes: [
        { fields: ['vehicle_id', 'start_time', 'end_time'] },
        { fields: ['mac_id_gps', 'start_time'] },
        { fields: ['start_time'] }
    ]
});

module.exports = Trip;