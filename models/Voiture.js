const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Voiture = sequelize.define("voitures", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    voiture_unique_id: { type: DataTypes.STRING, allowNull: false },
    immatriculation: { type: DataTypes.STRING, allowNull: false },
    mac_id_gps: { type: DataTypes.STRING, allowNull: false },
    marque: { type: DataTypes.STRING, allowNull: false },
    model: { type: DataTypes.STRING, allowNull: false },
    couleur: { type: DataTypes.STRING, allowNull: false },
    photo: { type: DataTypes.STRING, allowNull: true },
}, {
    timestamps: false // ✅ Disable Sequelize automatic timestamps
});

module.exports = Voiture;
