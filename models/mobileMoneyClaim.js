const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// A staff member's own capture of a mobile money confirmation SMS, submitted
// after they manually dial a USSD transfer to a vehicle owner (the
// "recouvrement semi-auto" flow). Nothing here is verified against MTN/Orange
// directly — there is no merchant/aggregator integration, only the SMS the
// staff member's own phone received — so every claim starts PENDING and
// needs human review before it settles anything.
const MobileMoneyClaim = sequelize.define(
    "mobile_money_claims",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },
        submitted_by_user_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
        },
        network: {
            type: DataTypes.STRING(20),
            allowNull: false,
        },
        amount: {
            type: DataTypes.DECIMAL(12, 2),
            allowNull: true,
        },
        sender_name: { type: DataTypes.STRING(255), allowNull: true },
        sender_phone: { type: DataTypes.STRING(50), allowNull: true },
        recipient_name: { type: DataTypes.STRING(255), allowNull: true },
        recipient_phone: { type: DataTypes.STRING(50), allowNull: true },
        // Unique per network — this is the idempotency key that stops the
        // same confirmation SMS from being recorded twice.
        reference: {
            type: DataTypes.STRING(100),
            allowNull: false,
        },
        transaction_timestamp: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        fee: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        new_balance: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        // Always kept, even when every structured field parsed cleanly — the
        // one thing a reviewer can always fall back to.
        raw_sms_text: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: "PENDING",
        },
        captured_at_device: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        tableName: "mobile_money_claims",
        timestamps: true,
        underscored: true,
        createdAt: "created_at",
        updatedAt: "updated_at",
    }
);

module.exports = MobileMoneyClaim;
