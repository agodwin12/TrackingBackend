const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Location = sequelize.define("locations", {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true
    },
    sys_time: {
        type: DataTypes.DATE,
        allowNull: false
    },
    user_name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    longitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true
    },
    latitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true
    },
    datetime: {
        type: DataTypes.DATE,
        allowNull: true
    },
    heart_time: {
        type: DataTypes.DATE,
        allowNull: true
    },
    speed: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    status: {
        type: DataTypes.STRING,
        allowNull: true
    },
    direction: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    mac_id_gps: {
        type: DataTypes.STRING,
        allowNull: false
    },

    // ✅ Vehicle FK — survives GPS swaps
    voiture_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'voitures',
            key: 'id'
        }
    },

    // ✅ Trip processing fields
    processed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false
    },
    trip_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'trips',
            key: 'id'
        }
    }
}, {
    timestamps: false,

    indexes: [
        // Individual indexes
        { name: 'idx_locations_processed',                  fields: ['processed'] },
        { name: 'idx_locations_mac_id_gps',                 fields: ['mac_id_gps'] },
        { name: 'idx_locations_trip_id',                    fields: ['trip_id'] },
        { name: 'idx_locations_sys_time',                   fields: ['sys_time'] },
        { name: 'idx_locations_voiture_id',                 fields: ['voiture_id'] },           // ✅ new

        // Composite indexes
        { name: 'idx_locations_mac_processed',              fields: ['mac_id_gps', 'processed'] },
        { name: 'idx_locations_mac_processed_time',         fields: ['mac_id_gps', 'processed', 'sys_time'] },
        { name: 'idx_locations_voiture_processed',          fields: ['voiture_id', 'processed'] },          // ✅ new
        { name: 'idx_locations_voiture_processed_time',     fields: ['voiture_id', 'processed', 'sys_time'] } // ✅ new
    ]
});

module.exports = Location;