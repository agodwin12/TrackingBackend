// migrations/202607281530-add-audit-fields-to-commands.js
'use strict';

// The `commands` table already tracks manual/stolen-report relay commands
// (CmdNo, status) but the automatic geofence engine-cutoff path never wrote
// to it at all — there was no record of when an auto-cutoff command was
// sent, whether the GPS provider actually accepted it, or whether the
// vehicle's relay was verified to have actually opened. These columns close
// that gap without touching any existing column.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        console.log('🧾 Adding audit fields to commands table...');

        await queryInterface.addColumn('commands', 'trigger_source', {
            type: Sequelize.STRING(30),
            allowNull: true,
            comment: "Who/what triggered this command: 'manual' | 'geofence_auto' | 'stolen_report'",
            after: 'type_commande'
        });
        console.log('✅ Added trigger_source column');

        await queryInterface.addColumn('commands', 'trigger_alert_id', {
            type: Sequelize.INTEGER.UNSIGNED,
            allowNull: true,
            comment: 'alerts.id that triggered this command, when applicable (no FK constraint by design)',
            after: 'trigger_source'
        });
        console.log('✅ Added trigger_alert_id column');

        await queryInterface.addColumn('commands', 'speed_at_send', {
            type: Sequelize.DECIMAL(6, 2),
            allowNull: true,
            comment: 'Vehicle speed (km/h) read from locations at the moment the command was dispatched',
            after: 'trigger_alert_id'
        });
        console.log('✅ Added speed_at_send column');

        await queryInterface.addColumn('commands', 'sent_at', {
            type: Sequelize.DATE,
            allowNull: true,
            comment: 'Exact moment the command was dispatched to the GPS provider (vs. created_at, which is when the pending row was first inserted)',
            after: 'speed_at_send'
        });
        console.log('✅ Added sent_at column');

        await queryInterface.addColumn('commands', 'provider_response', {
            type: Sequelize.JSON,
            allowNull: true,
            comment: 'Raw GPS provider response for the send attempt',
            after: 'sent_at'
        });
        console.log('✅ Added provider_response column');

        await queryInterface.addColumn('commands', 'verified_at', {
            type: Sequelize.DATE,
            allowNull: true,
            comment: 'When we re-checked the device state after sending, to confirm the relay actually toggled',
            after: 'provider_response'
        });
        console.log('✅ Added verified_at column');

        await queryInterface.addColumn('commands', 'verification_result', {
            type: Sequelize.STRING(30),
            allowNull: true,
            comment: "'engine_confirmed_off' | 'engine_still_on' | 'no_response' | 'skipped_simulated' | 'skipped_not_ok'",
            after: 'verified_at'
        });
        console.log('✅ Added verification_result column');

        await queryInterface.addIndex('commands', ['trigger_alert_id'], {
            name: 'idx_commands_trigger_alert_id'
        });
        console.log('✅ Added index on trigger_alert_id');

        await queryInterface.addIndex('commands', ['trigger_source'], {
            name: 'idx_commands_trigger_source'
        });
        console.log('✅ Added index on trigger_source');

        console.log('🎉 commands audit fields added successfully!');
    },

    down: async (queryInterface, Sequelize) => {
        console.log('🔄 Rolling back commands audit fields...');

        await queryInterface.removeIndex('commands', 'idx_commands_trigger_source');
        await queryInterface.removeIndex('commands', 'idx_commands_trigger_alert_id');

        await queryInterface.removeColumn('commands', 'verification_result');
        await queryInterface.removeColumn('commands', 'verified_at');
        await queryInterface.removeColumn('commands', 'provider_response');
        await queryInterface.removeColumn('commands', 'sent_at');
        await queryInterface.removeColumn('commands', 'speed_at_send');
        await queryInterface.removeColumn('commands', 'trigger_alert_id');
        await queryInterface.removeColumn('commands', 'trigger_source');

        console.log('🎉 Rollback completed successfully!');
    }
};
