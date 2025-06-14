const fs = require('fs').promises;
const path = require('path');

// 通知身份组配置存储路径
const NOTIFICATION_DATA_DIR = path.join(__dirname, '..', 'data');
const NOTIFICATION_DATA_FILE = path.join(NOTIFICATION_DATA_DIR, 'notification_roles.json');

// 确保数据目录存在
async function ensureDataDir() {
    try {
        await fs.access(NOTIFICATION_DATA_DIR);
    } catch {
        await fs.mkdir(NOTIFICATION_DATA_DIR, { recursive: true });
    }
}

// 读取通知配置数据
async function loadNotificationData() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(NOTIFICATION_DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

// 保存通知配置数据
async function saveNotificationData(data) {
    try {
        await ensureDataDir();
        await fs.writeFile(NOTIFICATION_DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('保存通知配置失败:', error);
        throw error;
    }
}

// 获取服务器的通知配置
async function getNotificationConfig(guildId) {
    try {
        const allData = await loadNotificationData();
        return allData[guildId] || {
            guildId,
            roles: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('获取通知配置失败:', error);
        return {
            guildId,
            roles: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }
}

// 保存服务器的通知配置
async function saveNotificationConfig(guildId, config) {
    try {
        const allData = await loadNotificationData();
        config.updatedAt = new Date().toISOString();
        allData[guildId] = config;
        await saveNotificationData(allData);
    } catch (error) {
        console.error('保存通知配置失败:', error);
        throw error;
    }
}

// 获取用户的身份组设置
async function getUserRoleSettings(guildId, userId) {
    try {
        const config = await getNotificationConfig(guildId);
        const userSettings = config.userSettings || {};
        return userSettings[userId] || [];
    } catch (error) {
        console.error('获取用户身份组设置失败:', error);
        return [];
    }
}

// 保存用户的身份组设置
async function saveUserRoleSettings(guildId, userId, roleIds) {
    try {
        const config = await getNotificationConfig(guildId);
        if (!config.userSettings) {
            config.userSettings = {};
        }
        config.userSettings[userId] = roleIds;
        await saveNotificationConfig(guildId, config);
    } catch (error) {
        console.error('保存用户身份组设置失败:', error);
        throw error;
    }
}

module.exports = {
    getNotificationConfig,
    saveNotificationConfig,
    getUserRoleSettings,
    saveUserRoleSettings
}; 