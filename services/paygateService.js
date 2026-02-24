require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const PAYGATE_BASE_URL = process.env.PAYGATE_BASE_URL;
const API_KEY = process.env.PAYGATE_API_KEY;

/**
 * Génère une référence unique pour l'application cliente
 * Format : TRX{YYMMDD}.{HHMM}.{RANDOM}
 */
const generateReference = (prefix = 'TRX') => {
    const now = new Date();

    const yy = now.getFullYear().toString().slice(-2);
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    const datePart = `${yy}${mm}${dd}`;

    const hh = now.getHours().toString().padStart(2, '0');
    const min = now.getMinutes().toString().padStart(2, '0');
    const timePart = `${hh}${min}`;

    const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();

    return `${prefix}${datePart}.${timePart}.${randomPart}`;
};

/**
 * Initialise une session de paiement auprès du Paygate
 * @param {number} amount - Le montant (ex: 1000)
 * @param {string} [phone] - (Optionnel) Numéro de téléphone
 * @param {string} [provider] - (Optionnel) MTNMOMO ou CMORANGEOM
 * @param {string} [customRef] - (Optionnel) Référence externe personnalisée
 */
const initiatePayment = async (amount, phone = '', provider = '', customRef = '') => {
    if (!API_KEY) throw new Error("Configuration PayGate manquante");

    // Utilise la référence fournie ou en génère une nouvelle
    const uniqueRef = customRef || generateReference('HOS'); // HOS pour Hôpital par exemple

    try {
        // Construction dynamique du payload
        const payload = {
            amount: amount,
            external_reference: uniqueRef,
            success_url: process.env.PAYGATE_SUCCESS_URL,
        };

        // Ajout des champs optionnels s'ils existent
        if (process.env.PAYGATE_CANCEL_URL) {
            payload.cancel_url = process.env.PAYGATE_CANCEL_URL;
        }
        if (phone) {
            payload.phone_number = phone;
        }
        if (provider) {
            payload.provider = provider;
        }

        console.log(`🚀 [PAYGATE] Init Transaction | Ref: ${uniqueRef} | Montant: ${amount}`);

        // Attention : On utilise le bon endpoint de ton nouveau backend Django
        const response = await axios.post(
            `${PAYGATE_BASE_URL}/create-checkout-session/`,
            payload,
            {
                headers: {
                    'Authorization': `Api-Key ${API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // On retourne toutes les infos de Django (notamment session_token et redirect_url)
        return {
            ...response.data,
            generated_ref: uniqueRef
        };

    } catch (error) {
        if (error.response) {
            console.error("❌ [PAYGATE REFUS] Status:", error.response.status);
            console.error("❌ [PAYGATE REFUS] Data:", JSON.stringify(error.response.data));
        } else {
            console.error("❌ [PAYGATE ERREUR]", error.message);
        }
        throw new Error("Impossible d'initialiser le paiement PayGate");
    }
};

/**
 * Vérifie le statut d'une transaction chez PayGate
 * @param {string} reference - La référence unique
 */
const verifyTransaction = async (reference) => {
    if (!API_KEY) throw new Error("Config manquante");

    try {
        console.log(`🔎 [PAYGATE] Vérification ref: ${reference}`);
        const response = await axios.get(
            `${PAYGATE_BASE_URL}/transaction/status`, // À adapter si ton endpoint Django est différent
            {
                params: { ref: reference },
                headers: {
                    'Authorization': `Api-Key ${API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;

    } catch (error) {
        console.error("❌ [PAYGATE VERIFY ERROR]", error.response?.data || error.message);
        throw new Error("Impossible de vérifier la transaction");
    }
};

module.exports = { initiatePayment, verifyTransaction };