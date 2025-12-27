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

// ========== 轨道系统相关函数 ==========

/**
 * 将旧数据结构迁移到多轨道系统
 * @param {Object} oldSettings - 旧的设置数据
 * @returns {Object} 迁移后的设置数据
 */
function migrateToTrackSystem(oldSettings) {
    // 如果已经是新格式，直接返回
    if (oldSettings.tracks && oldSettings.defaultTrackId) {
        return oldSettings;
    }

    console.log(`检测到旧数据格式，开始迁移到多轨道系统 - guildId: ${oldSettings.guildId}`);

    const now = new Date().toISOString();
    
    // 创建新的数据结构
    const migratedSettings = {
        guildId: oldSettings.guildId,
        defaultTrackId: 'default',
        tracks: {
            'default': {
                id: 'default',
                name: '默认轨道',
                description: '系统自动迁移的原有配置',
                reviewForumId: oldSettings.reviewForumId || null,
                contestCategoryId: oldSettings.contestCategoryId || null,
                allowedForumIds: oldSettings.allowedForumIds || [],
                tagMap: oldSettings.tagMap || {},
                createdAt: now,
                updatedAt: now
            }
        },
        // 全局共用配置
        itemsPerPage: oldSettings.itemsPerPage || 6,
        reviewerRoles: oldSettings.reviewerRoles || [],
        applicationPermissionRoles: oldSettings.applicationPermissionRoles || [],
        
        // 保留旧字段用于向后兼容
        reviewForumId: oldSettings.reviewForumId,
        contestCategoryId: oldSettings.contestCategoryId,
        allowedForumIds: oldSettings.allowedForumIds,
        tagMap: oldSettings.tagMap,
        
        updatedAt: now
    };

    console.log(`数据迁移完成 - 已创建默认轨道`);
    return migratedSettings;
}

/**
 * 获取下一个可用的轨道ID
 * @param {Object} tracks - 当前的轨道对象
 * @returns {string} 新的轨道ID (track_2, track_3, ...)
 */
function getNextTrackId(tracks) {
    if (!tracks || Object.keys(tracks).length === 0) {
        return 'default';
    }

    // 获取所有以 track_ 开头的ID
    const trackNumbers = Object.keys(tracks)
        .filter(id => id.startsWith('track_'))
        .map(id => parseInt(id.replace('track_', '')))
        .filter(num => !isNaN(num));

    if (trackNumbers.length === 0) {
        return 'track_2'; // 第一个新增轨道
    }

    const maxNumber = Math.max(...trackNumbers);
    return `track_${maxNumber + 1}`;
}

/**
 * 获取赛事设置（支持自动迁移）
 * @param {string} guildId - 服务器ID
 * @returns {Object|null} 设置数据
 */
async function getContestSettings(guildId) {
    const allSettings = readJsonFile(CONTEST_SETTINGS_FILE);
    let settings = allSettings[guildId];
    
    if (!settings) {
        return null;
    }

    // 检测并自动迁移旧数据
    if (!settings.tracks || !settings.defaultTrackId) {
        settings = migrateToTrackSystem(settings);
        // 保存迁移后的数据
        allSettings[guildId] = settings;
        writeJsonFile(CONTEST_SETTINGS_FILE, allSettings);
        console.log(`已自动迁移并保存 guildId: ${guildId} 的数据`);
    }

    return settings;
}

/**
 * 创建新轨道
 * @param {string} guildId - 服务器ID
 * @param {string} trackId - 轨道ID（可选，不提供则自动生成）
 * @param {Object} trackData - 轨道数据
 * @returns {Object} 创建的轨道数据
 */
async function createTrack(guildId, trackId, trackData) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        throw new Error('服务器赛事设置不存在');
    }

    // 如果没有提供trackId，自动生成
    if (!trackId) {
        trackId = getNextTrackId(settings.tracks);
    }

    // 检查ID是否已存在
    if (settings.tracks[trackId]) {
        throw new Error(`轨道ID已存在: ${trackId}`);
    }

    const now = new Date().toISOString();
    const newTrack = {
        id: trackId,
        name: trackData.name || `轨道 ${trackId}`,
        description: trackData.description || '',
        reviewForumId: trackData.reviewForumId || null,
        contestCategoryId: trackData.contestCategoryId || null,
        allowedForumIds: trackData.allowedForumIds || [],
        tagMap: trackData.tagMap || {},
        createdAt: now,
        updatedAt: now
    };

    settings.tracks[trackId] = newTrack;
    settings.updatedAt = now;
    
    await saveContestSettings(settings);
    console.log(`成功创建轨道 - ID: ${trackId}, 名称: ${newTrack.name}`);
    return newTrack;
}

/**
 * 更新轨道
 * @param {string} guildId - 服务器ID
 * @param {string} trackId - 轨道ID
 * @param {Object} updates - 更新的数据
 * @returns {Object} 更新后的轨道数据
 */
async function updateTrack(guildId, trackId, updates) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        throw new Error('服务器赛事设置不存在');
    }

    if (!settings.tracks[trackId]) {
        throw new Error(`轨道不存在: ${trackId}`);
    }

    const now = new Date().toISOString();
    settings.tracks[trackId] = {
        ...settings.tracks[trackId],
        ...updates,
        id: trackId, // 确保ID不被修改
        updatedAt: now
    };
    settings.updatedAt = now;

    await saveContestSettings(settings);
    console.log(`成功更新轨道 - ID: ${trackId}`);
    return settings.tracks[trackId];
}

/**
 * 删除轨道
 * @param {string} guildId - 服务器ID
 * @param {string} trackId - 轨道ID
 * @returns {boolean} 是否删除成功
 */
async function deleteTrack(guildId, trackId) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        throw new Error('服务器赛事设置不存在');
    }

    if (!settings.tracks[trackId]) {
        throw new Error(`轨道不存在: ${trackId}`);
    }

    // 禁止删除当前默认轨道
    if (settings.defaultTrackId === trackId) {
        throw new Error('无法删除当前默认轨道，请先将其他轨道设为默认');
    }

    delete settings.tracks[trackId];
    settings.updatedAt = new Date().toISOString();

    await saveContestSettings(settings);
    console.log(`成功删除轨道 - ID: ${trackId}`);
    return true;
}

/**
 * 获取单个轨道
 * @param {string} guildId - 服务器ID
 * @param {string} trackId - 轨道ID
 * @returns {Object|null} 轨道数据
 */
async function getTrack(guildId, trackId) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        return null;
    }
    return settings.tracks[trackId] || null;
}

/**
 * 获取所有轨道
 * @param {string} guildId - 服务器ID
 * @returns {Object} 所有轨道数据
 */
async function getAllTracks(guildId) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        return {};
    }
    return settings.tracks || {};
}

/**
 * 设置默认轨道
 * @param {string} guildId - 服务器ID
 * @param {string} trackId - 轨道ID
 * @returns {Object} 更新后的设置
 */
async function setDefaultTrack(guildId, trackId) {
    const settings = await getContestSettings(guildId);
    if (!settings) {
        throw new Error('服务器赛事设置不存在');
    }

    if (!settings.tracks[trackId]) {
        throw new Error(`轨道不存在: ${trackId}`);
    }

    settings.defaultTrackId = trackId;
    settings.updatedAt = new Date().toISOString();

    await saveContestSettings(settings);
    console.log(`成功设置默认轨道 - ID: ${trackId}`);
    return settings;
}

// ========== 结束轨道系统相关函数 ==========

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
    
    let application = null;
    
    // 尝试直接查找
    if (applications[applicationId]) {
        application = applications[applicationId];
    }
    // 如果直接查找失败，尝试转换为字符串查找
    else if (applications[String(applicationId)]) {
        application = applications[String(applicationId)];
    }
    // 如果还是失败，遍历查找匹配的ID
    else {
        for (const appId in applications) {
            const app = applications[appId];
            if (app.id == applicationId) { // 使用 == 而不是 === 来处理类型转换
                application = app;
                break;
            }
        }
    }
    
    if (!application) {
        console.log(`未找到申请ID: ${applicationId}`);
        console.log('当前所有申请ID:', Object.keys(applications));
        return null;
    }
    
    // 向后兼容：如果申请没有trackId，自动补充为defaultTrackId
    if (!application.trackId && application.guildId) {
        const settings = await getContestSettings(application.guildId);
        if (settings && settings.defaultTrackId) {
            application.trackId = settings.defaultTrackId;
            console.log(`申请 ${applicationId} 缺少trackId，自动补充为: ${application.trackId}`);
        }
    }
    
    return application;
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
    let channel = channels[channelId];
    console.log(`查询结果:`, channel ? '找到' : '未找到');
    
    // 向后兼容：如果频道没有trackId，自动补充为defaultTrackId
    if (channel && !channel.trackId && channel.guildId) {
        const settings = await getContestSettings(channel.guildId);
        if (settings && settings.defaultTrackId) {
            channel.trackId = settings.defaultTrackId;
            console.log(`频道 ${channelId} 缺少trackId，自动补充为: ${channel.trackId}`);
        }
    }
    
    return channel;
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

// 新增：获取频道的获奖作品
async function getAwardedSubmissions(contestChannelId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    return Object.values(submissions).filter(sub => 
        sub.contestChannelId === contestChannelId && 
        sub.isValid && 
        sub.awardInfo && 
        sub.awardInfo.awardName
    );
}

// 新增：设置作品获奖信息
async function setSubmissionAward(globalId, awardName, awardMessage = '') {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[globalId]) {
        submissions[globalId].awardInfo = {
            awardName: awardName,
            awardMessage: awardMessage,
            awardedAt: new Date().toISOString()
        };
        writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
        console.log(`设置获奖信息 - 全局ID: ${globalId}, 奖项: ${awardName}`);
        return submissions[globalId];
    }
    return null;
}

// 新增：移除作品获奖信息
async function removeSubmissionAward(globalId) {
    const submissions = readJsonFile(CONTEST_SUBMISSIONS_FILE);
    if (submissions[globalId] && submissions[globalId].awardInfo) {
        delete submissions[globalId].awardInfo;
        writeJsonFile(CONTEST_SUBMISSIONS_FILE, submissions);
        console.log(`移除获奖信息 - 全局ID: ${globalId}`);
        return submissions[globalId];
    }
    return null;
}

// 新增：设置比赛完赛状态
async function setContestFinished(contestChannelId, finished = true) {
    const channels = readJsonFile(CONTEST_CHANNELS_FILE);
    if (channels[contestChannelId]) {
        channels[contestChannelId].isFinished = finished;
        channels[contestChannelId].finishedAt = finished ? new Date().toISOString() : null;
        writeJsonFile(CONTEST_CHANNELS_FILE, channels);
        console.log(`设置比赛完赛状态 - 频道: ${contestChannelId}, 状态: ${finished}`);
        return channels[contestChannelId];
    }
    return null;
}

module.exports = {
    // 设置相关
    saveContestSettings,
    getContestSettings,
    
    // 轨道系统相关
    createTrack,
    updateTrack,
    deleteTrack,
    getTrack,
    getAllTracks,
    setDefaultTrack,
    getNextTrackId,
    
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
    deleteContestSubmission,
    
    // 其他功能
    getAwardedSubmissions,
    setSubmissionAward,
    removeSubmissionAward,
    setContestFinished
};