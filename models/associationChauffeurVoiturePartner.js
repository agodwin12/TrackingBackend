// models/associationChauffeurVoiturePartner.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AssociationChauffeurVoiturePartner = sequelize.define(
    "association_chauffeur_voiture_partner",
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },
        voiture_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            comment: 'ID of the vehicle',
        },
        chauffeur_id: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            comment: 'ID of the chauffeur (from users table)',
        },
        assigned_by: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: true,
            comment: 'ID of the user who made the assignment',
        },
        assigned_at: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            comment: 'Timestamp when assignment was made',
        },
        note: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Optional note about the assignment',
        },
    },
    {
        tableName: "association_chauffeur_voiture_partner",
        timestamps: true,
        underscored: true,
        createdAt: "created_at",
        updatedAt: "updated_at",
    }
);

module.exports = AssociationChauffeurVoiturePartner;