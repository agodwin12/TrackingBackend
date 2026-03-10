// models/payment.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Payment = sequelize.define(
    "payments",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },
        user_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            comment: "FK to users table - who made the payment",
        },
        vehicle_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            comment: "FK to voitures table - which vehicle this payment is for",
        },
        subscription_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: true,
            comment: "FK to subscriptions table - filled after payment succeeds",
        },
        plan_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            comment: "FK to subscription_plans table - which plan was purchased",
        },
        amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            comment: "Amount paid",
        },
        currency: {
            type: DataTypes.STRING(10),
            allowNull: false,
            defaultValue: "XAF",
            comment: "Currency used e.g. XAF",
        },
        method: {
            type: DataTypes.ENUM("MOBILE_MONEY", "CASH"),
            allowNull: false,
            comment: "Payment method used",
        },
        provider: {
            type: DataTypes.STRING(50),
            allowNull: true,
            comment: "e.g. MTN, ORANGE - only for Mobile Money",
        },
        phone_number: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: "Mobile money phone number used for payment",
        },
        transaction_ref: {
            type:      DataTypes.STRING(255),
            allowNull: true,
            unique:    true,   // kept — each payment row has its own unique ref ✅
            comment:   "Our generated reference sent to PayGate",
        },
        transaction_id: {
            type:      DataTypes.STRING(255),
            allowNull: true,
            // unique: true  ← REMOVED — batch payments share one PayGate
            //                 transaction_id across multiple rows.
            //                 Uniqueness is handled by a regular index below
            //                 for fast lookups without constraint violation.
            comment:   "PayGate transaction ID — shared across batch payment rows",
        },
        status: {
            type: DataTypes.ENUM("PENDING", "SUCCESS", "FAILED"),
            allowNull: false,
            defaultValue: "PENDING",
            comment: "Current status of the payment",
        },
        paid_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: "Timestamp when payment was confirmed successful",
        },
    },
    {
        tableName:  "payments",
        timestamps: true,
        underscored: true,
        createdAt:  "created_at",
        updatedAt:  "updated_at",

   
        indexes: [
            {
                unique: false,
                fields: ['transaction_id'],
                name:   'idx_payments_transaction_id',
            },
        ],
    }
);

module.exports = Payment;