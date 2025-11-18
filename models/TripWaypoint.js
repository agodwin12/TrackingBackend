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
    indexes: [
        { fields: ['trip_id', 'sequence_order'] },
        { fields: ['recorded_at'] }
    ]
});

module.exports = TripWaypoint;