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

// ─── User / Voiture ───────────────────────────────────────────────────────────

AssociationUserVoiture.belongsTo(Voiture, {
    foreignKey: "voiture_id",
    as: "voiture"
});

AssociationChauffeurVoiturePartner.belongsTo(Voiture, {
    foreignKey: "voiture_id",
    as: "voiture"
});

// ─── Voiture / Trip ───────────────────────────────────────────────────────────

Voiture.hasMany(Trip, {
    foreignKey: 'vehicle_id',
    as: 'trips',
    onDelete: 'CASCADE'
});
Trip.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ─── Trip / TripWaypoint ──────────────────────────────────────────────────────

Trip.hasMany(TripWaypoint, {
    foreignKey: 'trip_id',
    as: 'waypoints',
    onDelete: 'CASCADE'
});
TripWaypoint.belongsTo(Trip, {
    foreignKey: 'trip_id',
    as: 'trip'
});

// ─── Trip / Location ──────────────────────────────────────────────────────────

Trip.hasMany(Location, {
    foreignKey: 'trip_id',
    as: 'locations'
});
Location.belongsTo(Trip, {
    foreignKey: 'trip_id',
    as: 'trip'
});

// ─── Voiture / Alert ──────────────────────────────────────────────────────────

Voiture.hasMany(Alert, {
    foreignKey: 'voiture_id',
    as: 'alerts',
    onDelete: 'CASCADE'
});
Alert.belongsTo(Voiture, {
    foreignKey: 'voiture_id',
    as: 'vehicle'
});

// ─── Voiture / SafeZone ───────────────────────────────────────────────────────

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

// ─── SubscriptionPlan / Subscription ─────────────────────────────────────────

SubscriptionPlan.hasMany(Subscription, {
    foreignKey: 'plan_id',
    as: 'subscriptions'
});
Subscription.belongsTo(SubscriptionPlan, {
    foreignKey: 'plan_id',
    as: 'plan'
});

// ─── User / Subscription ──────────────────────────────────────────────────────

User.hasMany(Subscription, {
    foreignKey: 'user_id',
    as: 'subscriptions'
});
Subscription.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

// ─── Voiture / Subscription ───────────────────────────────────────────────────

Voiture.hasMany(Subscription, {
    foreignKey: 'vehicle_id',
    as: 'subscriptions'
});
Subscription.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ─── Subscription / Payment ───────────────────────────────────────────────────

// One subscription can have many payments (e.g. monthly renewals)
Subscription.hasMany(Payment, {
    foreignKey: 'subscription_id',
    as: 'payments'
});
Payment.belongsTo(Subscription, {
    foreignKey: 'subscription_id',
    as: 'subscription'
});

// The single payment that first activated/created this subscription
Subscription.belongsTo(Payment, {
    foreignKey: 'payment_id',
    as: 'activatingPayment',
    constraints: false  // avoids circular FK constraint issues at migration time
});

// ─── User / Payment ───────────────────────────────────────────────────────────

User.hasMany(Payment, {
    foreignKey: 'user_id',
    as: 'payments'
});
Payment.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

// ─── Voiture / Payment ────────────────────────────────────────────────────────

Voiture.hasMany(Payment, {
    foreignKey: 'vehicle_id',
    as: 'payments'
});
Payment.belongsTo(Voiture, {
    foreignKey: 'vehicle_id',
    as: 'vehicle'
});

// ─── SubscriptionPlan / Payment ───────────────────────────────────────────────

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