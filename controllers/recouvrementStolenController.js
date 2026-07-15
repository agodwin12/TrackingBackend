// controllers/recouvrementStolenController.js

const AssociationChauffeurVoiturePartner = require("../models/associationChauffeurVoiturePartner");
const Voiture = require("../models/voiture");
const Command = require("../models/Command");
const Alert = require("../models/Alert");

const {
    sendGpsCommandWithFallback,
} = require("../services/GpsService");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    return text.length ? text : fallback;
}

function extractCmdNo(providerResp) {
    if (Array.isArray(providerResp?.data) && providerResp.data.length > 0) {
        return providerResp.data[0]?.CmdNo || null;
    }

    return null;
}

function extractProviderReturnMsg(providerResp) {
    if (Array.isArray(providerResp?.data) && providerResp.data.length > 0) {
        return providerResp.data[0]?.ReturnMsg || null;
    }

    return (
        providerResp?.errorDescribe ||
        providerResp?.msg ||
        providerResp?.message ||
        null
    );
}

function shouldTryNextGpsAccount(result) {
    if (!result || result.ok) return false;

    const msg = String(result.message || "").toLowerCase();
    const raw = JSON.stringify(result.providerResp || {}).toLowerCase();

    return (
        msg.includes("device") ||
        msg.includes("customer") ||
        msg.includes("not_customer") ||
        msg.includes("does not exist") ||
        msg.includes("permission") ||
        msg.includes("permissions") ||
        raw.includes("devicenot") ||
        raw.includes("device does not exist") ||
        raw.includes("not_customer") ||
        raw.includes("customer does not exist") ||
        raw.includes("permission") ||
        raw.includes("permissions")
    );
}

async function sendCloseRelayUsingAvailableGpsAccounts(macId) {
    const accounts = ["tracking", "mobility"];

    let lastResult = null;

    for (const accountName of accounts) {
        console.log(
            `🚨 [Recouvrement stolen] Trying CLOSERELAY for MAC=${macId} using GPS account="${accountName}"`
        );

        const result = await sendGpsCommandWithFallback({
            accountName,
            macId,
            command: "CLOSERELAY",
            params: "",
            sendTime: "",
        });

        const normalizedResult = {
            ok: !!result?.ok,
            message: result?.message || extractProviderReturnMsg(result?.providerResp),
            providerResp: result?.providerResp || null,
            retried: !!result?.retried,
            accountUsed: accountName,
            cmdNo: extractCmdNo(result?.providerResp),
        };

        if (normalizedResult.ok) {
            console.log(
                `✅ [Recouvrement stolen] CLOSERELAY sent successfully with account="${accountName}", CmdNo=${normalizedResult.cmdNo}`
            );
            return normalizedResult;
        }

        console.warn(
            `⚠️ [Recouvrement stolen] CLOSERELAY failed with account="${accountName}" | message=${normalizedResult.message}`
        );

        lastResult = normalizedResult;

        if (!shouldTryNextGpsAccount(normalizedResult)) {
            console.warn(
                "⚠️ [Recouvrement stolen] Failure does not look like account/device ownership issue. Not trying next account."
            );
            break;
        }
    }

    return lastResult || {
        ok: false,
        message: "No GPS account could send the command",
        providerResp: null,
        retried: false,
        accountUsed: null,
        cmdNo: null,
    };
}

async function findVehicleForChauffeur(userId) {
    const association = await AssociationChauffeurVoiturePartner.findOne({
        where: {
            chauffeur_id: userId,
        },
        order: [
            ["assigned_at", "DESC"],
            ["id", "DESC"],
        ],
    });

    if (!association) {
        return {
            association: null,
            voiture: null,
        };
    }

    const voiture = await Voiture.findByPk(association.voiture_id);

    return {
        association,
        voiture,
    };
}

async function createStolenAlert({ userId, voiture }) {
    const immatriculation = safeString(voiture.immatriculation, "N/A");
    const macIdGps = safeString(voiture.mac_id_gps, "N/A");

    return Alert.create({
        voiture_id: voiture.id,
        alert_type: "stolen",
        alert_subtype: "recouvrement_report",
        message: `Véhicule ${immatriculation} signalé volé depuis le tableau de bord recouvrement.`,
        alerted_at: new Date(),
        sent: false,
        read: false,
        processed: false,
        processed_by: null,
        latitude: voiture.latitude || null,
        longitude: voiture.longitude || null,
        alert_status: "ACTIVE",
        metadata: {
            source: "recouvrement_dashboard",
            reported_by_user_id: userId,
            voiture_id: voiture.id,
            immatriculation,
            mac_id_gps: macIdGps,
            requested_command: "CLOSERELAY",
            command_reason: "stolen_vehicle_report",
        },
    });
}

async function createPendingCommand({ userId, voiture }) {
    return Command.create({
        user_id: userId,
        employe_id: null,
        vehicule_id: voiture.id,
        CmdNo: `LOCAL-${Date.now()}-${voiture.id}`,
        status: "pending",
        type_commande: "STOLEN_CLOSE_RELAY",
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

exports.reportStolenFromRecouvrement = async (req, res) => {
    try {
        const userId = req.user?.id || req.body.userId;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "userId is required",
            });
        }

        console.log(
            `🚨 [Recouvrement stolen] Report stolen requested by userId=${userId}`
        );

        const { association, voiture } = await findVehicleForChauffeur(userId);

        if (!association) {
            return res.status(404).json({
                success: false,
                message: "Aucune voiture associée à ce chauffeur",
            });
        }

        if (!voiture) {
            return res.status(404).json({
                success: false,
                message: "Voiture associée introuvable",
                data: {
                    associationId: association.id,
                    voitureId: association.voiture_id,
                },
            });
        }

        const macIdGps = safeString(voiture.mac_id_gps);

        if (!macIdGps) {
            return res.status(422).json({
                success: false,
                message: "Cette voiture n'a pas de GPS configuré",
                data: {
                    voitureId: voiture.id,
                    immatriculation: voiture.immatriculation,
                },
            });
        }

        // 1. Register alert using existing alerts table
        const alert = await createStolenAlert({
            userId,
            voiture,
        });

        // 2. Register local command as pending
        const commandRecord = await createPendingCommand({
            userId,
            voiture,
        });

        // 3. Send CLOSERELAY using tracking first, mobility second
        const gpsResult = await sendCloseRelayUsingAvailableGpsAccounts(macIdGps);

        // 4. Update command record
        await commandRecord.update({
            CmdNo: gpsResult.cmdNo || commandRecord.CmdNo,
            status: gpsResult.ok ? "sent" : "failed",
        });

        // 5. Update alert metadata with command result
        await alert.update({
            sent: gpsResult.ok,
            metadata: {
                ...(alert.metadata || {}),
                command_id: commandRecord.id,
                command_status: gpsResult.ok ? "sent" : "failed",
                command_cmd_no: gpsResult.cmdNo || commandRecord.CmdNo,
                gps_account_used: gpsResult.accountUsed,
                gps_message: gpsResult.message,
                gps_retried: gpsResult.retried,
                gps_provider_response: gpsResult.providerResp,
            },
        });

        return res.status(gpsResult.ok ? 200 : 502).json({
            success: gpsResult.ok,
            message: gpsResult.ok
                ? "Alerte vol enregistrée et coupure moteur envoyée"
                : "Alerte vol enregistrée, mais la coupure moteur a échoué",
            data: {
                userId: Number(userId),
                associationId: association.id,
                voitureId: voiture.id,
                immatriculation: voiture.immatriculation,
                macIdGps,
                command: "CLOSERELAY",
                accountUsed: gpsResult.accountUsed,
                cmdNo: gpsResult.cmdNo || commandRecord.CmdNo,
                commandId: commandRecord.id,
                alertId: alert.id,
                gpsMessage: gpsResult.message,
                retried: gpsResult.retried,
                providerResp: gpsResult.providerResp,
            },
        });
    } catch (error) {
        console.error("❌ [Recouvrement stolen] Controller error:", error);

        return res.status(500).json({
            success: false,
            message: "Erreur lors du signalement vol recouvrement",
            error: error.message,
        });
    }
};