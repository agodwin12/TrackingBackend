const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AssociationUserVoiture = sequelize.define("association_user_voitures", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    voiture_id: { type: DataTypes.BIGINT, allowNull: false },
}, { timestamps: false });

module.exports = AssociationUserVoiture;
