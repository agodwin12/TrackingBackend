// On importe le service
const { initiatePayment } = require('../services/paygateService');

/**
 * Gère l'initialisation d'un paiement depuis le frontend
 */
const initiateCheckout = async (req, res) => {
    try {
        // 1. Récupération des données
        const { amount, phone_number, provider, external_reference } = req.body;

        // 2. Validation basique
        if (!amount) {
            return res.status(400).json({
                success: false,
                message: "Le montant est obligatoire."
            });
        }

        // 3. Appel au service PayGate
        const paygateResponse = await initiatePayment(
            amount,
            phone_number,
            provider,
            external_reference
        );

        // 4. Renvoi au frontend
        return res.status(200).json({
            success: true,
            message: "Paiement initialisé avec succès",
            transaction_id: paygateResponse.transaction_id,
            session_token: paygateResponse.session_token,
            reference: paygateResponse.generated_ref,
            redirect_url: paygateResponse.redirect_url,
            expires_at: paygateResponse.expires_at
        });

    } catch (error) {
        console.error("❌ [CONTROLLER ERROR] Erreur lors du checkout:", error.message);

        return res.status(500).json({
            success: false,
            message: "Une erreur est survenue lors de l'initialisation du paiement.",
            error: error.message
        });
    }
};

// On exporte la ou les fonctions du contrôleur
module.exports = {
    initiateCheckout
};