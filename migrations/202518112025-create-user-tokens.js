'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('user_tokens', {
            id: {
                type: Sequelize.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            user_id: {
                type: Sequelize.BIGINT,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id'
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            token: {
                type: Sequelize.STRING(500),
                allowNull: false,
                unique: true
            },
            device_type: {
                type: Sequelize.ENUM('android', 'ios'),
                allowNull: false
            },
            device_id: {
                type: Sequelize.STRING(255),
                allowNull: true
            },
            last_used: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.NOW
            },
            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.NOW
            },
            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.NOW
            }
        });

        await queryInterface.addIndex('user_tokens', ['user_id']);
        await queryInterface.addIndex('user_tokens', ['token']);
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('user_tokens');
    }
};