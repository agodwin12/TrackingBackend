const AssociationUserVoiture = require("./AssociationUserVoiture");
const Voiture = require("./Voiture");
const Trip = require("./Trip");
const TripWaypoint = require("./TripWaypoint");
const Location = require("./Location");
const Alert = require("./Alert");
const SafeZone = require("./safeZoneModel");

// Define association
AssociationUserVoiture.belongsTo(Voiture, { foreignKey: "voiture_id" });

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

// ✅ Voiture → SafeZone (One-to-Many) - ADD constraints: false
Voiture.hasMany(SafeZone, {
    foreignKey: 'vehicle_id',
    as: 'safeZones',
    constraints: false  // ✅ Disable foreign key constraint creation
});
SafeZone.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle',
    constraints: false  // ✅ Disable foreign key constraint creation
});

module.exports = {
    AssociationUserVoiture,
    Voiture,
    TripWaypoint,
    Location,
    Trip,
    Alert,
    SafeZone
};