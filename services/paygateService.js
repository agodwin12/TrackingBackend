require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const PAYGATE_BASE_URL = process.env.PAYGATE_BASE_URL;
const API_KEY = process.env.PAYGATE_API_KEY;

// Dial codes by ISO country code (digits only, no '+')
// PayGate expects the number WITH dial code prefix, e.g. 237XXXXXXXXX
const DIAL_CODES = {
    CM: '237',
    NG: '234',
    GH: '233',
    CI: '225',
    BJ: '229',
    CG: '242',
    TG: '228',
    SN: '221',
    ML: '223',
    BF: '226',
    NE: '227',
    TD: '235',
    US: '1',
    FR: '33',
};

/**
 * Normalizes a local phone number to the full international format
 * required by PayGate (dial code + local number, no '+' or spaces).
 * - If the number already starts with the dial code, it is returned as-is.
 * - If countryCode is unknown, the number is returned unchanged.
 */
const _normalizePhone = (phone, countryCode) => {
    if (!phone) return phone;
    const clean = phone.replace(/\s+/g, '');
    const dialCode = DIAL_CODES[countryCode];
    if (!dialCode) return clean;                              // unknown country — pass through
    if (clean.startsWith(dialCode)) return clean;             // already prefixed
    if (clean.startsWith(`+${dialCode}`)) return clean.slice(1); // has '+', strip it
    return `${dialCode}${clean}`;                             // prepend dial code
};

/**
 * Génère une référence unique pour l'application cliente
 * Format : FLT{YYMMDD}.{HHMM}.{RANDOM}
 */
const generateReference = (prefix = 'FLT') => {
    const now = new Date();

    const yy  = now.getFullYear().toString().slice(-2);
    const mm  = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd  = now.getDate().toString().padStart(2, '0');
    const datePart = `${yy}${mm}${dd}`;

    const hh  = now.getHours().toString().padStart(2, '0');
    const min = now.getMinutes().toString().padStart(2, '0');
    const timePart = `${hh}${min}`;

    const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();

    return `${prefix}${datePart}.${timePart}.${randomPart}`;
};

/**
 * Initialise une session de paiement auprès du Paygate
 * @param {number} amount        - Le montant (ex: 1000)
 * @param {string} [phone]       - (Optionnel) Numéro de téléphone sans indicatif pays
 * @param {string} [provider]    - (Optionnel) MTNMOMO ou CMORANGEOM
 * @param {string} [customRef]   - (Optionnel) Référence externe personnalisée
 * @param {string} [countryCode] - (Optionnel) Code ISO 2 lettres ex: CM, FR, NG
 * @param {string} [currency]    - (Requis) Code devise ISO ex: XAF, NGN, EUR
 */
const initiatePayment = async (amount, phone = '', provider = '', customRef = '', countryCode = null, currency = 'XAF') => {
    if (!API_KEY) throw new Error('Configuration PayGate manquante');

    const uniqueRef = customRef || generateReference();

    // Normalize phone to full international format (e.g. 696098576 → 237696098576)
    const normalizedPhone = _normalizePhone(phone, countryCode);

    try {
        const payload = {
            amount:             amount,
            currency:           currency,
            external_reference: uniqueRef,
            success_url:        process.env.PAYGATE_SUCCESS_URL,
        };

        if (process.env.PAYGATE_CANCEL_URL) {
            payload.cancel_url = process.env.PAYGATE_CANCEL_URL;
        }
        if (normalizedPhone) {
            payload.phone_number = normalizedPhone;
        }
        if (provider) {
            payload.provider = provider;
        }
        if (countryCode) {
            payload.country_code = countryCode;
        }

        console.log(`🚀 [PAYGATE] Init Transaction | Ref: ${uniqueRef} | Montant: ${amount} ${currency} | Phone: ${normalizedPhone || 'N/A'}${countryCode ? ` | Country: ${countryCode}` : ''}`);

        const response = await axios.post(
            `${PAYGATE_BASE_URL}/create-checkout-session/`,
            payload,
            {
                headers: {
                    'Authorization': `Api-Key ${API_KEY}`,
                    'Content-Type':  'application/json',
                }
            }
        );

        return {
            ...response.data,
            generated_ref: uniqueRef,
        };

    } catch (error) {
        if (error.response) {
            console.error('❌ [PAYGATE REFUS] Status:', error.response.status);
            console.error('❌ [PAYGATE REFUS] Data:', JSON.stringify(error.response.data));
        } else {
            console.error('❌ [PAYGATE ERREUR]', error.message);
        }
        throw new Error("Impossible d'initialiser le paiement PayGate");
    }
};

/**
 * Vérifie le statut d'une transaction chez PayGate
 * @param {string} reference - La référence unique
 */
const verifyTransaction = async (reference) => {
    if (!API_KEY) throw new Error('Config manquante');

    try {
        console.log(`🔎 [PAYGATE] Vérification ref: ${reference}`);

        const response = await axios.get(
            `${PAYGATE_BASE_URL}/transaction/status`,
            {
                params:  { ref: reference },
                headers: {
                    'Authorization': `Api-Key ${API_KEY}`,
                    'Content-Type':  'application/json',
                }
            }
        );

        return response.data;

    } catch (error) {
        console.error('❌ [PAYGATE VERIFY ERROR]', error.response?.data || error.message);
        throw new Error('Impossible de vérifier la transaction');
    }
};

module.exports = { initiatePayment, verifyTransaction };