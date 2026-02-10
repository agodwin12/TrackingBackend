// migrations/YYYYMMDDHHMMSS-add-battery-tracking-to-vehicles.js
'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        console.log('🔋 Adding battery tracking columns to vehicles table...');

        // Add battery_level column
        await queryInterface.addColumn('voitures', 'battery_level', {
            type: Sequelize.INTEGER,
            allowNull: true,
            comment: 'Current battery level percentage (0-100)',
            after: 'status'
        });
        console.log('✅ Added battery_level column');

        // Add last_battery_check column
        await queryInterface.addColumn('voitures', 'last_battery_check', {
            type: Sequelize.DATE,
            allowNull: true,
            comment: 'Timestamp of last battery level check',
            after: 'battery_level'
        });
        console.log('✅ Added last_battery_check column');

        // Add index for faster queries on battery_level
        await queryInterface.addIndex('voitures', ['battery_level'], {
            name: 'idx_battery_level'
        });
        console.log('✅ Added index on battery_level');

        console.log('🎉 Battery tracking columns added successfully!');
    },

    down: async (queryInterface, Sequelize) => {
        console.log('🔄 Rolling back battery tracking columns...');

        // Remove index
        await queryInterface.removeIndex('voitures', 'idx_battery_level');
        console.log('✅ Removed index on battery_level');

        // Remove columns
        await queryInterface.removeColumn('voitures', 'last_battery_check');
        console.log('✅ Removed last_battery_check column');

        await queryInterface.removeColumn('voitures', 'battery_level');
        console.log('✅ Removed battery_level column');

        console.log('🎉 Rollback completed successfully!');
    }
};