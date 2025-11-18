// migrations/XXXXXXXXXXXXXX-create-locations-history-table.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    console.log('🔄 Creating locations_history table...');

    await queryInterface.createTable('locations_history', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      sys_time: {
        type: Sequelize.BIGINT,
        allowNull: true
      },
      user_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      longitude: {
        type: Sequelize.DECIMAL(10, 8),
        allowNull: true
      },
      latitude: {
        type: Sequelize.DECIMAL(10, 8),
        allowNull: true
      },
      datetime: {
        type: Sequelize.DATE,
        allowNull: true
      },
      heart_time: {
        type: Sequelize.DATE,
        allowNull: true
      },
      speed: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      status: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      direction: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      mac_id_gps: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      archived_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    console.log('✅ locations_history table created');

    // Add indexes for performance
    console.log('🔄 Adding indexes to locations_history...');

    await queryInterface.addIndex('locations_history', ['mac_id_gps', 'datetime'], {
      name: 'idx_history_mac_datetime',
      using: 'BTREE'
    });

    await queryInterface.addIndex('locations_history', ['datetime'], {
      name: 'idx_history_datetime',
      using: 'BTREE'
    });

    await queryInterface.addIndex('locations_history', ['mac_id_gps', 'sys_time'], {
      name: 'idx_history_mac_systime',
      using: 'BTREE'
    });

    await queryInterface.addIndex('locations_history', ['archived_at'], {
      name: 'idx_history_archived_at',
      using: 'BTREE'
    });

    console.log('✅ Indexes added to locations_history');
    console.log('✅ Migration complete!');
  },

  down: async (queryInterface, Sequelize) => {
    console.log('🔄 Dropping locations_history table...');
    await queryInterface.dropTable('locations_history');
    console.log('✅ locations_history table dropped');
  }
};