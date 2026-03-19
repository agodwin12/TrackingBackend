const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Subscription = sequelize.define(
    "subscriptions",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },
        vehicle_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
        },
        user_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
        },
        plan_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
        },
        // The payment that activated this subscription.
        // Null until payment is confirmed by the webhook.
        payment_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: true,
        },
        start_date: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        end_date: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        status: {
            type: DataTypes.ENUM("ACTIVE", "EXPIRED", "CANCELLED"),
            allowNull: false,
            defaultValue: "ACTIVE",
        },
        auto_renew: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
    },
    {
        tableName: "subscriptions",
        timestamps: true,
        underscored: true,
        createdAt: "created_at",
        updatedAt: "updated_at",
    }
);

module.exports = Subscription;