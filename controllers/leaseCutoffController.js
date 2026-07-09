// controllers/leaseCutoffController.js
const sequelize = require('../config/database');
const logger    = require('../utils/logger');

exports.getCutoffTime = async (req, res) => {
    console.log('🔥 [CutoffTime] HIT — user:', req.user?.id, 'immat:', req.query.immatriculation);

    try {
        const immatriculation = req.query.immatriculation;

        if (!immatriculation || immatriculation.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'immatriculation query param is required',
            });
        }

        logger.info(`⏱ [CutoffTime] Fetching cutoff for immatriculation=${immatriculation}`);

        const [row] = await sequelize.query(`
            SELECT
                lcr.cutoff_time,
                lcr.is_enabled,
                lcr.timezone,
                v.id AS vehicle_id,
                v.immatriculation
            FROM voitures v
            JOIN lease_cutoff_contract_rules lcr ON lcr.vehicle_id = v.id
            WHERE v.immatriculation = :immatriculation
              AND lcr.is_enabled = 1
            LIMIT 1
        `, {
            replacements: { immatriculation: immatriculation.trim() },
            type:         sequelize.QueryTypes.SELECT,
        });

        if (!row) {
            logger.info(`⚠️ [CutoffTime] No cutoff rule found for immatriculation=${immatriculation}`);
            return res.status(404).json({
                success: false,
                message: 'No cutoff rule found for this vehicle',
            });
        }

        const [hours, minutes, seconds] = row.cutoff_time.split(':').map(Number);
        const now         = new Date();
        const cutoffToday = new Date(
            now.getFullYear(), now.getMonth(), now.getDate(),
            hours, minutes, seconds ?? 0,
        );

        const isCutoffPassed     = now >= cutoffToday;
        const nextCutoff         = isCutoffPassed
            ? new Date(cutoffToday.getTime() + 24 * 60 * 60 * 1000)
            : cutoffToday;
        const secondsUntilCutoff = Math.max(
            0,
            Math.floor((nextCutoff.getTime() - now.getTime()) / 1000),
        );

        logger.info(`✅ [CutoffTime] cutoff=${row.cutoff_time} | secondsLeft=${secondsUntilCutoff} | passed=${isCutoffPassed}`);

        return res.json({
            success:              true,
            cutoff_time:          row.cutoff_time,
            is_enabled:           Boolean(row.is_enabled),
            vehicle_id:           row.vehicle_id,
            immatriculation:      row.immatriculation,
            cutoff_today_iso:     cutoffToday.toISOString(),
            next_cutoff_iso:      nextCutoff.toISOString(),
            seconds_until_cutoff: secondsUntilCutoff,
            is_cutoff_passed:     isCutoffPassed,
        });

    } catch (error) {
        logger.error(`🔥 [CutoffTime] Error: ${error.message}`);
        return res.status(500).json({
            success:  false,
            message:  'Server error',
            error:    error.message,
        });
    }
};