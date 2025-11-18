// backend/migrations/YYYYMMDDHHMMSS-add-device-tokens.js
'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('device_tokens', {
            id: {
                type: Sequelize.BIGINT.UNSIGNED,
                primaryKey: true,
                autoIncrement: true,
                allowNull: false
            },
            user_id: {
                type: Sequelize.BIGINT.UNSIGNED,
                allowNull: false
                // ✅ Removed foreign key constraint for now
            },
            token: {
                type: Sequelize.STRING(500),
                allowNull: false,
                unique: true
            },
            device_type: {
                type: Sequelize.ENUM('android', 'ios', 'web'),
                allowNull: false,
                defaultValue: 'android'
            },
            device_id: {
                type: Sequelize.STRING(255),
                allowNull: true
            },
            is_active: {
                type: Sequelize.BOOLEAN,
                defaultValue: true,
                allowNull: false
            },
            last_used_at: {
                type: Sequelize.DATE,
                allowNull: true
            },
            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            }
        });

        // Add indexes
        await queryInterface.addIndex('device_tokens', ['user_id']);
        await queryInterface.addIndex('device_tokens', ['token']);
        await queryInterface.addIndex('device_tokens', ['is_active']);
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('device_tokens');
    }
};