// controllers/authController.js
const User = require("../models/userModel");
const Voiture = require("../models/voiture");
const Subscription = require("../models/subscription");
const AssociationUserVoiture = require("../models/AssociationUserVoiture");
const AssociationChauffeurVoiturePartner = require("../models/associationChauffeurVoiturePartner");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { validationResult } = require("express-validator");

// ✅ Only fetch columns that exist in the voitures table
const VOITURE_ATTRIBUTES = [
    'id',
    'voiture_unique_id',
    'immatriculation',
    'mac_id_gps',
    'marque',
    'model',
    'couleur',
    'photo',
    'nickname',
    'latitude',
    'longitude',
];

const normalizePhone = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
    }
    return cleaned;
};

// ========== HELPER: Fetch vehicles for a REGULAR user ==========
async function fetchRegularUserVehicles(userId) {
    const rows = await AssociationUserVoiture.findAll({
        where: { user_id: userId },
        include: [
            {
                model: Voiture,
                as: 'voiture',
                attributes: VOITURE_ATTRIBUTES,
            }
        ]
    });

    return rows.map(row => row.voiture).filter(v => v !== null);
}

// ========== HELPER: Fetch vehicles for a CHAUFFEUR (partner user) ==========
async function fetchChauffeurVehicles(chauffeurId) {
    const rows = await AssociationChauffeurVoiturePartner.findAll({
        where: { chauffeur_id: chauffeurId },
        include: [
            {
                model: Voiture,
                as: 'voiture',
                attributes: VOITURE_ATTRIBUTES,
            }
        ],
        order: [['assigned_at', 'DESC']]
    });

    return rows.map(row => row.voiture).filter(v => v !== null);
}

// ========== HELPER: Check subscription status for a list of vehicle IDs ==========
// Returns a Map<vehicleId, boolean> — true means the vehicle has an active subscription
async function fetchVehicleSubscriptionMap(userId, vehicleIds) {
    if (!vehicleIds || vehicleIds.length === 0) return new Map();

    const now = new Date();

    const activeSubscriptions = await Subscription.findAll({
        where: {
            user_id: userId,
            vehicle_id: { [Op.in]: vehicleIds },
            status: 'ACTIVE',
            end_date: { [Op.gt]: now },   // end_date is still in the future
        },
        attributes: ['vehicle_id'],
    });

    // Build a Set of vehicle IDs that have an active subscription
    const activeVehicleIds = new Set(
        activeSubscriptions.map(s => Number(s.vehicle_id))
    );

    const map = new Map();
    for (const id of vehicleIds) {
        map.set(id, activeVehicleIds.has(Number(id)));
    }

    return map;
}

// ========== LOGIN ==========
exports.login = async (req, res) => {
    try {
        // STEP 1: Validate Input
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log("❌ Validation failed:", errors.array());
            return res.status(400).json({
                message: "Invalid input",
                errors: errors.array()
            });
        }

        const { phone, password, keepMeLoggedIn } = req.body;

        // STEP 2: Normalize Phone Number
        const normalizedPhone = normalizePhone(phone);
        console.log(`🔹 Login attempt for: ${normalizedPhone}`);

        // STEP 3: Find User
        const user = await User.findOne({ where: { phone: normalizedPhone } });

        // STEP 4: Validate Password
        if (!user || !(await bcrypt.compare(password, user.password))) {
            console.log(`❌ Failed login attempt for: ${normalizedPhone}`);
            return res.status(401).json({
                message: "Invalid phone number or password"
            });
        }

        console.log(`✅ User authenticated: ID=${user.id}`);

        // STEP 5: Determine user type from partner_id
        const isChauffeur = user.partner_id !== null && user.partner_id !== undefined;
        const userType = isChauffeur ? 'chauffeur' : 'regular';
        console.log(`👤 User type: ${userType} (partner_id: ${user.partner_id})`);

        // STEP 6: Fetch vehicles using Sequelize
        let vehicles = [];

        if (isChauffeur) {
            console.log(`🚗 Fetching from association_chauffeur_voiture_partner...`);
            vehicles = await fetchChauffeurVehicles(user.id);
        } else {
            console.log(`🚗 Fetching from association_user_voitures...`);
            vehicles = await fetchRegularUserVehicles(user.id);
        }

        console.log(`🚗 Found ${vehicles.length} vehicle(s)`);

        // STEP 7: Block login if no vehicles assigned
        if (vehicles.length === 0) {
            console.log(`❌ No vehicles assigned for user ID: ${user.id}`);
            return res.status(403).json({
                message: "No vehicles assigned to your account. Please contact your administrator."
            });
        }

        // STEP 8: Check subscription status for each vehicle
        const vehicleIds = vehicles.map(v => v.id);
        const subscriptionMap = await fetchVehicleSubscriptionMap(user.id, vehicleIds);

        // Attach has_active_subscription flag to each vehicle
        const vehiclesWithSubscription = vehicles.map(v => ({
            ...v.toJSON(),
            has_active_subscription: subscriptionMap.get(Number(v.id)) ?? false,
        }));

        // Overall account subscription status:
        // ACTIVE if at least one vehicle has a valid subscription, otherwise NONE
        const hasAnyActiveSubscription = vehiclesWithSubscription.some(
            v => v.has_active_subscription
        );
        const subscriptionStatus = hasAnyActiveSubscription ? 'ACTIVE' : 'NONE';

        console.log(`📋 Subscription status: ${subscriptionStatus} (${vehiclesWithSubscription.filter(v => v.has_active_subscription).length}/${vehicles.length} vehicles active)`);

        // STEP 9: Generate Access Token (90 days)
        const accessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id,
                user_type: userType
            },
            process.env.JWT_SECRET,
            { expiresIn: "90d" }
        );

        // STEP 10: Generate Refresh Token (180 days)
        const refreshToken = jwt.sign(
            { id: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "180d" }
        );

        // STEP 11: Store refresh token in database
        const refreshTokenExpiresAt = new Date();
        refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 180);

        await user.update({
            refresh_token: refreshToken,
            refresh_token_expires_at: refreshTokenExpiresAt
        });

        // STEP 12: Set refresh token in httpOnly cookie
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 180 * 24 * 60 * 60 * 1000
        });

        console.log(`✅ Login successful — User: ${user.id} | Type: ${userType} | Vehicles: ${vehicles.length} | Subscription: ${subscriptionStatus}`);

        // STEP 13: Send Response
        return res.json({
            message: "Login successful",
            isFirstLogin: user.is_first_login,
            user_type: userType,
            subscription_status: subscriptionStatus,   // 'ACTIVE' | 'NONE'
            user: {
                id: user.id,
                user_unique_id: user.user_unique_id,
                nom: user.nom,
                prenom: user.prenom,
                phone: user.phone,
                email: user.email,
                ville: user.ville,
                quartier: user.quartier,
                photo: user.photo,
                partner_id: user.partner_id,
            },
            vehicles: vehiclesWithSubscription,        // each vehicle now has has_active_subscription
            accessToken,
            refreshToken,
        });

    } catch (error) {
        console.error("🔥 Login Error:", error.message);
        console.error("🔥 Stack:", error.stack);
        return res.status(500).json({
            message: "Server error. Please try again later."
        });
    }
};

// ========== LOGOUT ==========
exports.logout = async (req, res) => {
    try {
        const userId = req.user.id;

        await User.update(
            {
                refresh_token: null,
                refresh_token_expires_at: null
            },
            { where: { id: userId } }
        );

        res.clearCookie('refreshToken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        });

        console.log(`✅ User ${userId} logged out`);
        return res.json({ message: "Logged out successfully" });

    } catch (error) {
        console.error("🔥 Logout error:", error);
        return res.status(500).json({ message: "Error logging out" });
    }
};

// ========== REFRESH TOKEN ==========
exports.refreshToken = async (req, res) => {
    try {
        let refreshToken = req.cookies.refreshToken;

        if (!refreshToken && req.body.refreshToken) {
            refreshToken = req.body.refreshToken;
            console.log("🔄 Using refresh token from request body");
        }

        if (!refreshToken) {
            return res.status(401).json({ message: "No refresh token provided" });
        }

        let decoded;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ message: "Invalid refresh token" });
        }

        const user = await User.findByPk(decoded.id);

        if (!user || user.refresh_token !== refreshToken) {
            return res.status(401).json({ message: "Invalid refresh token" });
        }

        if (user.refresh_token_expires_at && new Date() > new Date(user.refresh_token_expires_at)) {
            return res.status(401).json({ message: "Refresh token expired" });
        }

        const userType = (user.partner_id !== null && user.partner_id !== undefined)
            ? 'chauffeur'
            : 'regular';

        const newAccessToken = jwt.sign(
            {
                id: user.id,
                phone: user.phone,
                user_unique_id: user.user_unique_id,
                user_type: userType
            },
            process.env.JWT_SECRET,
            { expiresIn: "90d" }
        );

        console.log(`✅ Token refreshed for user ${user.id}`);

        return res.json({
            message: "Token refreshed successfully",
            accessToken: newAccessToken
        });

    } catch (error) {
        console.error("🔥 Refresh token error:", error);
        return res.status(500).json({ message: "Error refreshing token" });
    }
};