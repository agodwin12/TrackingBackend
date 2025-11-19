const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Location = sequelize.define("locations", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    sys_time: { type: DataTypes.DATE, allowNull: false },
    user_name: { type: DataTypes.STRING, allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    datetime: { type: DataTypes.DATE, allowNull: true },
    heart_time: { type: DataTypes.DATE, allowNull: true },
    speed: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    status: { type: DataTypes.STRING, allowNull: true },
    direction: { type: DataTypes.INTEGER, allowNull: true },
    mac_id_gps: { type: DataTypes.STRING, allowNull: false },

    // ✅ NEW FIELDS for trip processing
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
        { fields: ['processed', 'mac_id_gps', 'sys_time'] },
        { fields: ['trip_id'] }
    ]
});

module.exports = Location;