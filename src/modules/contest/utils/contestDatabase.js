// src/modules/contest/utils/contestDatabase.js
const fs = require('fs');
const path = require('path');

// 确保数据目录存在
const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CONTEST_SETTINGS_FILE = path.join(DATA_DIR, 'contestSettings.json');
const CONTEST_APPLICATIONS_FILE = path.join(DATA_DIR, 'contestApplications.json');
const CONTEST_CHANNELS_FILE = path.join(DATA_DIR, 'contestChannels.json');
const CONTEST_SUBMISSIONS_FILE = path.join(DATA_DIR, 'contestSubmissions.json');

// 初始化文件
[CONTEST_SETTINGS_FILE, CONTEST_APPLICATIONS_FILE, CONTEST_CHANNELS_FILE, CONTEST_SUBMISSIONS_FILE].forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '{}', 'utf8');
    }
});

// 基础读写函数
function readJsonFile(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`读取文件失败 ${filePath}:`, err);
        return {};
    }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`写入文件失败 ${filePath}:`, err);
    }
}

// 赛事设置相关
async function saveContestSettings(settingsData) {
    const allSettings = readJsonFile(CONTEST_SETTINGS_FILE);
    
    // 支持两种调用方式：新方式(单个对象)和旧方式(兼容性)
    let guildId, settings;
    if (typeof settingsData === 'string') {
        // 旧方式：saveContestSettings(guildId, settings)
        guildId = settingsData;
        settings = arguments[1] || {};
    } else {
        // 新方式：saveContestSettings(settingsObject)
        guildId = settingsData.guildId;
        settings = settingsData;
    }
    
    allSettings[guildId] = {
        ...settings,
        guildId,
        updatedAt: new Date().toISOString()
    };
    writeJsonFile(CONTEST_SETTINGS_FILE, allSettings);
    console.log(`成功保存赛事设置 - guildId: ${guildId}`, settings);
    return allSettings[guildId];
}

async function getContestSettings(guildId) {
    const allSettings = readJsonFile(CONTEST_SETTINGS_FILE);
    return allSettings[guildId];
}

// 申请相关
function getNextApplicationId() {
    const applications = readJsonFile(CONTEST_APPLICATIONS_FILE);
    let maxId = 0;
    for (const appId in applications) {
        const app = applications[appId];
        if (app.id && !isNaN(parseInt(app.id))) {
            maxId = Math.max(maxId, parseInt(app.id));
        }
    }
    return maxId + 1;
}

async function saveContestApplication(applicationData) {
    const applications = readJsonFile(CONTEST_APPLICATIONS_FILE);
    applications[applicationData.id] = applicationData;
    writeJsonFile(CONTEST_APPLICATIONS_FILE, applications);
    console.log(`成功保存赛事申请 - ID: ${applicationData.id}`);
    return applicationData;
}

async function getContestApplication(applicationId) {
    const applications = readJsonFile(CONTEST_APPLICATIONS_FILE);
    
    // 尝试直接查找
    if (applications[applicationId]) {
        return applications[applicationId];
    }
    
    // 如果直接查找失败，尝试转换为字符串查找
    const stringId = String(applicationId);
    if (applications[stringId]) {
        return applications[stringId];
    }
    
    // 如果还是失败，遍历查找匹配的ID
    for (const appId in applications) {
        const app = applications[appId];
        if (app.id == applicationId) { // 使用 == 而不是 === 来处理类型转换
            return app;
        }
    }
    
    console.log(`未找到申请ID: ${applicationId}`);
    console.log('当前所有申请ID:', Object.keys(applications));
    return null;
}

async function updateContestApplication(applicationId, updates) {
    const applications = readJsonFile(CONTEST_APPLICATIONS_FILE);
    if (applications[applicationId]) {
        applications[applicationId] = { ...applications[applicationId], ...updates };
        writeJsonFile(CONTEST_APPLICATIONS_FILE, applications);
        return applications[applicationId];
    }
    return null;
}

async function getAllContestApplications() {
    return readJsonFile(CONTEST_APPLICATIONS_FILE);
}

// 赛事频道相关
async function saveContestChannel(channelData) {
    const channels = readJsonFile(CONTEST_CHANNELS_FILE);
    channels[channelData.channelId] = channelData;
    writeJsonFile(CONTEST_CHANNELS_FILE, channels);
    console.log(`成功保存赛事频道 - ID: ${channelData.channelId}`);
    return channelData;
}

async function getContestChannel(channelId) {
    const channels = readJsonFile(CONTEST_CHANNELS_FILE);
    console.log(`查询赛事频道 - 频道ID: ${channelId}`);
    console.log(`所有赛事频道ID:`, Object.keys(channels));
    const result = channels[channelId];
    console.log(`查询结果:`, result ? '找到' : '未找到');
    return result;
}

async function updateContestChannel(channelId, updates) {
    const channels = readJsonFile(CONTEST_CHANNELS_FILE);
    if (channels[channelId]) {
        channels[channelId] = { ...channels[channelId], ...updates };
        writeJsonFile(CONTEST_CHANNELS_FILE, channels);
        return channels[channelId];
    }
    return null;
}

// 投稿相关
function getNextSubmissionId(contestChannelId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    let maxId = 0;
    
    // 只查找当前比赛的投稿，获取最大ID
    for (const subId in submissions) {
        const sub = submissions[subId];
        if (sub.contestChannelId === contestChannelId && sub.contestSubmissionId && !isNaN(parseInt(sub.contestSubmissionId))) {
            maxId = Math.max(maxId, parseInt(sub.contestSubmissionId));
        }
    }
    return maxId + 1;
}

// 新增：获取全局唯一ID（用于存储键）
function getNextGlobalSubmissionId() {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    let maxId = 0;
    for (const subId in submissions) {
        const sub = submissions[subId];
        if (sub.globalId && !isNaN(parseInt(sub.globalId))) {
            maxId = Math.max(maxId, parseInt(sub.globalId));
        }
    }
    return maxId + 1;
}

async function saveContestSubmission(submissionData) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    
    // 使用全局唯一ID作为存储键，但保留比赛内的独立ID
    const globalId = getNextGlobalSubmissionId();
    const submissionWithGlobalId = {
        ...submissionData,
        globalId: globalId // 添加全局唯一ID用于存储
    };
    
    submissions[globalId] = submissionWithGlobalId;
    writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
    console.log(`成功保存投稿 - 全局ID: ${globalId}, 比赛内ID: ${submissionData.contestSubmissionId}, 比赛: ${submissionData.contestChannelId}`);
    return submissionWithGlobalId;
}

// 修改：通过比赛内ID和比赛频道ID查找投稿
async function getContestSubmission(contestSubmissionId, contestChannelId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    
    // 遍历查找匹配的投稿
    for (const globalId in submissions) {
        const sub = submissions[globalId];
        if (sub.contestSubmissionId == contestSubmissionId && sub.contestChannelId === contestChannelId) {
            return sub;
        }
    }
    
    console.log(`未找到投稿 - 比赛内ID: ${contestSubmissionId}, 比赛: ${contestChannelId}`);
    return null;
}

// 新增：通过全局ID查找投稿（用于内部操作）
async function getContestSubmissionByGlobalId(globalId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    return submissions[globalId] || null;
}

async function getSubmissionsByChannel(channelId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    return Object.values(submissions).filter(sub => sub.contestChannelId === channelId);
}

// 修改：通过全局ID更新投稿
async function updateContestSubmission(globalId, updates) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[globalId]) {
        submissions[globalId] = { ...submissions[globalId], ...updates };
        writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
        return submissions[globalId];
    }
    return null;
}

// 修改：通过全局ID删除投稿
async function deleteContestSubmission(globalId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[globalId]) {
        delete submissions[globalId];
        writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
        return true;
    }
    return false;
}

module.exports = {
    // 设置相关
    saveContestSettings,
    getContestSettings,
    
    // 申请相关
    getNextApplicationId,
    saveContestApplication,
    getContestApplication,
    updateContestApplication,
    getAllContestApplications,
    
    // 频道相关
    saveContestChannel,
    getContestChannel,
    updateContestChannel,
    
    // 投稿相关
    getNextSubmissionId,
    saveContestSubmission,
    getContestSubmission,
    getContestSubmissionByGlobalId,
    getSubmissionsByChannel,
    updateContestSubmission,
    deleteContestSubmission
};