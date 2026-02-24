// models/associations.js
const AssociationUserVoiture = require("./AssociationUserVoiture");
const AssociationChauffeurVoiturePartner = require("./associationChauffeurVoiturePartner");
const Voiture = require("./voiture");
const Trip = require("./trip");
const TripWaypoint = require("./tripWaypoint");
const Location = require("./location");
const Alert = require("./Alert");
const SafeZone = require("./safeZoneModel");

// ✅ Regular user → Voiture (with alias so authController include works)
AssociationUserVoiture.belongsTo(Voiture, {
    foreignKey: "voiture_id",
    as: "voiture"
});

// ✅ Chauffeur partner → Voiture (new association)
AssociationChauffeurVoiturePartner.belongsTo(Voiture, {
    foreignKey: "voiture_id",
    as: "voiture"
});

// ✅ Voiture → Trip (One-to-Many)
Voiture.hasMany(Trip, {
    foreignKey: 'vehicle_id',
    as: 'trips',
    onDelete: 'CASCADE'
});
Trip.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ✅ Trip → TripWaypoint (One-to-Many)
Trip.hasMany(TripWaypoint, {
    foreignKey: 'trip_id',
    as: 'waypoints',
    onDelete: 'CASCADE'
});
TripWaypoint.belongsTo(Trip, {
    foreignKey: 'trip_id',
    as: 'trip'
});

// ✅ Trip → Location (One-to-Many)
Trip.hasMany(Location, {
    foreignKey: 'trip_id',
    as: 'locations'
});
Location.belongsTo(Trip, {
    foreignKey: 'trip_id',
    as: 'trip'
});

// ✅ Voiture → Alert (One-to-Many)
Voiture.hasMany(Alert, {
    foreignKey: 'voiture_id',
    as: 'alerts',
    onDelete: 'CASCADE'
});
Alert.belongsTo(Voiture, {
    foreignKey: 'voiture_id',
    as: 'vehicle'
});

// ✅ Voiture → SafeZone (One-to-Many)
Voiture.hasMany(SafeZone, {
    foreignKey: 'vehicle_id',
    as: 'safeZones',
    constraints: false
});
SafeZone.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle',
    constraints: false
});

module.exports = {
    AssociationUserVoiture,
    AssociationChauffeurVoiturePartner,
    Voiture,
    TripWaypoint,
    Location,
    Trip,
    Alert,
    SafeZone
};