// migrations/202607301230-add-description-to-commands.js
'use strict';

// Adds a human-readable description to each command row so anyone looking at
// the command log (support, partner, admin) can tell at a glance who/what
// triggered it without decoding trigger_source/type_commande values.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        console.log('🧾 Adding description column to commands table...');

        await queryInterface.addColumn('commands', 'description', {
            type: Sequelize.STRING(255),
            allowNull: true,
            comment: 'Human-readable description of who/what issued this command, e.g. "Geofence violation - recorded by System Admin"',
            after: 'trigger_source'
        });

        console.log('✅ Added description column');
    },

    down: async (queryInterface, Sequelize) => {
        console.log('🔄 Rolling back commands.description...');
        await queryInterface.removeColumn('commands', 'description');
        console.log('✅ Rollback complete');
    }
};
