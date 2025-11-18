// migrations/XXXXXXXXXXXXXX-add-indexes-to-locations.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    console.log('🔄 Adding performance indexes to locations table...');

    try {
      // Check if index exists before creating (prevents errors on re-run)
      const indexes = await queryInterface.showIndex('locations');
      const indexNames = indexes.map(idx => idx.name);

      // Index 1: For latest location queries (most common)
      if (!indexNames.includes('idx_mac_systime')) {
        console.log('  Adding idx_mac_systime...');
        await queryInterface.addIndex('locations', ['mac_id_gps', 'sys_time'], {
          name: 'idx_mac_systime',
          using: 'BTREE'
        });
        console.log('  ✅ idx_mac_systime added');
      } else {
        console.log('  ⏭️  idx_mac_systime already exists, skipping');
      }

      // Index 2: For datetime filtering
      if (!indexNames.includes('idx_datetime')) {
        console.log('  Adding idx_datetime...');
        await queryInterface.addIndex('locations', ['datetime'], {
          name: 'idx_datetime',
          using: 'BTREE'
        });
        console.log('  ✅ idx_datetime added');
      } else {
        console.log('  ⏭️  idx_datetime already exists, skipping');
      }

      // Index 3: For date range queries
      if (!indexNames.includes('idx_mac_datetime')) {
        console.log('  Adding idx_mac_datetime...');
        await queryInterface.addIndex('locations', ['mac_id_gps', 'datetime'], {
          name: 'idx_mac_datetime',
          using: 'BTREE'
        });
        console.log('  ✅ idx_mac_datetime added');
      } else {
        console.log('  ⏭️  idx_mac_datetime already exists, skipping');
      }

      console.log('✅ All indexes processed successfully!');

    } catch (error) {
      console.error('❌ Error adding indexes:', error.message);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    console.log('🔄 Removing indexes from locations table...');

    try {
      await queryInterface.removeIndex('locations', 'idx_mac_systime');
      console.log('  ✅ idx_mac_systime removed');
    } catch (e) {
      console.log('  ⏭️  idx_mac_systime does not exist');
    }

    try {
      await queryInterface.removeIndex('locations', 'idx_datetime');
      console.log('  ✅ idx_datetime removed');
    } catch (e) {
      console.log('  ⏭️  idx_datetime does not exist');
    }

    try {
      await queryInterface.removeIndex('locations', 'idx_mac_datetime');
      console.log('  ✅ idx_mac_datetime removed');
    } catch (e) {
      console.log('  ⏭️  idx_mac_datetime does not exist');
    }

    console.log('✅ Indexes removal complete!');
  }
};