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
    return channels[channelId];
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
function getNextSubmissionId() {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    let maxId = 0;
    for (const subId in submissions) {
        const sub = submissions[subId];
        if (sub.id && !isNaN(parseInt(sub.id))) {
            maxId = Math.max(maxId, parseInt(sub.id));
        }
    }
    return maxId + 1;
}

async function saveContestSubmission(submissionData) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    submissions[submissionData.id] = submissionData;
    writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
    console.log(`成功保存投稿 - ID: ${submissionData.id}`);
    return submissionData;
}

async function getContestSubmission(submissionId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    return submissions[submissionId];
}

async function getSubmissionsByChannel(channelId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    return Object.values(submissions).filter(sub => sub.contestChannelId === channelId);
}

async function updateContestSubmission(submissionId, updates) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[submissionId]) {
        submissions[submissionId] = { ...submissions[submissionId], ...updates };
        writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
        return submissions[submissionId];
    }
    return null;
}

async function deleteContestSubmission(submissionId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[submissionId]) {
        delete submissions[submissionId];
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
    getSubmissionsByChannel,
    updateContestSubmission,
    deleteContestSubmission
};