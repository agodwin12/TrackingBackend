// models/trip.js - CORRECTED WITHOUT updated_at
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Trip = sequelize.define("trips", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    vehicle_id: {
        type: DataTypes.BIGINT.UNSIGNED,
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
    // 🆕 NEW: Start address status tracking
    start_address_status: {
        type: DataTypes.ENUM('pending', 'geocoded', 'failed'),
        defaultValue: 'pending',
        allowNull: false
    },
    start_address_retry_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
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
    // 🆕 NEW: End address status tracking
    end_address_status: {
        type: DataTypes.ENUM('pending', 'geocoded', 'failed'),
        defaultValue: 'pending',
        allowNull: false
    },
    end_address_retry_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
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
    timestamps: false, // ✅ No automatic timestamps

    // ✅ ALL PERFORMANCE INDEXES
    indexes: [
        // Individual indexes
        {
            name: 'idx_trips_vehicle_id',
            fields: ['vehicle_id']
        },
        {
            name: 'idx_trips_status',
            fields: ['status']
        },
        {
            name: 'idx_trips_start_time',
            fields: ['start_time']
        },
        {
            name: 'idx_trips_mac_id_gps',
            fields: ['mac_id_gps']
        },
        {
            name: 'idx_trips_created_at',
            fields: ['created_at']
        },

        // Composite index (CRITICAL for getVehicleTrips performance!)
        {
            name: 'idx_trips_vehicle_status_time',
            fields: ['vehicle_id', 'status', 'start_time']
        },

        // 🆕 NEW: Indexes for background geocoding service
        {
            name: 'idx_trips_start_address_status',
            fields: ['start_address_status']
        },
        {
            name: 'idx_trips_end_address_status',
            fields: ['end_address_status']
        },
        {
            name: 'idx_trips_address_pending',
            fields: ['start_address_status', 'end_address_status', 'created_at']
        }
    ]
});

module.exports = Trip;