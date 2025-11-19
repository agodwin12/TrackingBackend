// models/userToken.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const User = require('./User');

const UserToken = sequelize.define('UserToken', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    user_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        references: {
            model: User,
            key: 'id'
        }
    },
    token: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: true
    },
    device_type: {
        type: DataTypes.ENUM('android', 'ios'),
        allowNull: false
    },
    device_id: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    last_used: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'user_tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});


// Relationships
UserToken.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(UserToken, { foreignKey: 'user_id' });


module.exports = UserToken;