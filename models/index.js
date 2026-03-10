// models/associations.js
const AssociationUserVoiture = require("./AssociationUserVoiture");
const AssociationChauffeurVoiturePartner = require("./associationChauffeurVoiturePartner");
const Voiture = require("./voiture");
const Trip = require("./trip");
const TripWaypoint = require("./tripWaypoint");
const Location = require("./location");
const Alert = require("./Alert");
const SafeZone = require("./safeZoneModel");
const User = require("./userModel");
const SubscriptionPlan = require("./subscriptionPlan");
const Subscription = require("./subscription");
const Payment = require("./payment");

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

// ✅ SubscriptionPlan → Subscription (One-to-Many)
SubscriptionPlan.hasMany(Subscription, {
    foreignKey: 'plan_id',
    as: 'subscriptions'
});
Subscription.belongsTo(SubscriptionPlan, {
    foreignKey: 'plan_id',
    as: 'plan'
});

// ✅ User → Subscription (One-to-Many)
User.hasMany(Subscription, {
    foreignKey: 'user_id',
    as: 'subscriptions'
});
Subscription.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

// ✅ Voiture → Subscription (One-to-Many)
Voiture.hasMany(Subscription, {
    foreignKey: 'vehicle_id',
    as: 'subscriptions'
});
Subscription.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ✅ User → Payment (One-to-Many)
User.hasMany(Payment, {
    foreignKey: 'user_id',
    as: 'payments'
});
Payment.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

// ✅ Voiture → Payment (One-to-Many)
Voiture.hasMany(Payment, {
    foreignKey: 'vehicle_id',
    as: 'payments'
});
Payment.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ✅ Subscription → Payment (One-to-Many)
Subscription.hasMany(Payment, {
    foreignKey: 'subscription_id',
    as: 'payments'
});
Payment.belongsTo(Subscription, {
    foreignKey: 'subscription_id',
    as: 'subscription'
});

// ✅ SubscriptionPlan → Payment (One-to-Many)
SubscriptionPlan.hasMany(Payment, {
    foreignKey: 'plan_id',
    as: 'payments'
});
Payment.belongsTo(SubscriptionPlan, {
    foreignKey: 'plan_id',
    as: 'plan'
});

module.exports = {
    AssociationUserVoiture,
    AssociationChauffeurVoiturePartner,
    Voiture,
    TripWaypoint,
    Location,
    Trip,
    Alert,
    SafeZone,
    User,
    SubscriptionPlan,
    Subscription,
    Payment
};