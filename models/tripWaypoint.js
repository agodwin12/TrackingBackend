const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const TripWaypoint = sequelize.define("trip_waypoints", {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true
    },
    trip_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'trips',
            key: 'id'
        }
    },

    // GPS data
    latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: false
    },
    longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: false
    },
    speed: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },

    // Timing
    recorded_at: {
        type: DataTypes.DATE,
        allowNull: false
    },
    sequence_order: {
        type: DataTypes.INTEGER,
        allowNull: false
    }
}, {
    timestamps: false,

    // ✅ ALL PERFORMANCE INDEXES
    indexes: [
        // Individual index
        {
            name: 'idx_trip_waypoints_trip_id',
            fields: ['trip_id']
        },
        {
            name: 'idx_trip_waypoints_recorded_at',
            fields: ['recorded_at']
        },

        // Composite index (CRITICAL for route fetching performance!)
        {
            name: 'idx_trip_waypoints_trip_sequence',
            fields: ['trip_id', 'sequence_order']
        }
    ]
});

module.exports = TripWaypoint;