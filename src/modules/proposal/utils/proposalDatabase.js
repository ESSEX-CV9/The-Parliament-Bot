// src/modules/proposal/utils/proposalDatabase.js
const fs = require('fs');
const path = require('path');

// 确保数据目录存在
const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PROPOSAL_SETTINGS_FILE = path.join(DATA_DIR, 'proposalSettings.json');
const PROPOSAL_APPLICATIONS_FILE = path.join(DATA_DIR, 'proposalApplications.json');

// 初始化文件
[PROPOSAL_SETTINGS_FILE, PROPOSAL_APPLICATIONS_FILE].forEach(file => {
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

// 议案设置相关
async function saveProposalSettings(guildId, settingsData) {
    const allSettings = readJsonFile(PROPOSAL_SETTINGS_FILE);
    allSettings[guildId] = {
        ...settingsData,
        guildId,
        updatedAt: new Date().toISOString()
    };
    writeJsonFile(PROPOSAL_SETTINGS_FILE, allSettings);
    console.log(`成功保存议案设置 - guildId: ${guildId}`, settingsData);
    return allSettings[guildId];
}

async function getProposalSettings(guildId) {
    const allSettings = readJsonFile(PROPOSAL_SETTINGS_FILE);
    return allSettings[guildId];
}

// 获取下一个议案申请ID
function getNextProposalId() {
    const applications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    let maxId = 0;
    for (const appId in applications) {
        const app = applications[appId];
        if (app.proposalId && !isNaN(parseInt(app.proposalId))) {
            maxId = Math.max(maxId, parseInt(app.proposalId));
        }
    }
    return maxId + 1;
}

// 保存议案申请
async function saveProposalApplication(applicationData) {
    const applications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    applications[applicationData.proposalId] = applicationData;
    writeJsonFile(PROPOSAL_APPLICATIONS_FILE, applications);
    console.log(`成功保存议案申请 - ID: ${applicationData.proposalId}`);
    return applicationData;
}

// 获取议案申请
async function getProposalApplication(proposalId) {
    const applications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    
    // 尝试直接查找
    if (applications[proposalId]) {
        return applications[proposalId];
    }
    
    // 如果直接查找失败，遍历所有申请查找匹配的ID
    for (const appId in applications) {
        const app = applications[appId];
        if (app.proposalId == proposalId) {
            return app;
        }
    }
    
    return null;
}

// 更新议案申请
async function updateProposalApplication(proposalId, updates) {
    const applications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    
    let targetKey = proposalId;
    
    // 如果直接键不存在，查找匹配的申请
    if (!applications[proposalId]) {
        for (const appId in applications) {
            const app = applications[appId];
            if (app.proposalId == proposalId) {
                targetKey = appId;
                break;
            }
        }
    }
    
    if (applications[targetKey]) {
        applications[targetKey] = {
            ...applications[targetKey],
            ...updates,
            updatedAt: new Date().toISOString()
        };
        writeJsonFile(PROPOSAL_APPLICATIONS_FILE, applications);
        console.log(`成功更新议案申请 - ID: ${proposalId}`, updates);
        return applications[targetKey];
    }
    
    console.warn(`未找到议案申请 - ID: ${proposalId}`);
    return null;
}

// 获取所有议案申请
async function getAllProposalApplications() {
    return readJsonFile(PROPOSAL_APPLICATIONS_FILE);
}

// 根据服务器ID获取议案申请
async function getProposalApplicationsByGuild(guildId) {
    const allApplications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    const guildApplications = {};
    
    for (const appId in allApplications) {
        const app = allApplications[appId];
        if (app.guildId === guildId) {
            guildApplications[appId] = app;
        }
    }
    
    return guildApplications;
}

// 根据状态获取议案申请
async function getProposalApplicationsByStatus(guildId, status) {
    const allApplications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    const filteredApplications = {};
    
    for (const appId in allApplications) {
        const app = allApplications[appId];
        if (app.guildId === guildId && app.status === status) {
            filteredApplications[appId] = app;
        }
    }
    
    return filteredApplications;
}

// 删除议案申请
async function deleteProposalApplication(proposalId) {
    const applications = readJsonFile(PROPOSAL_APPLICATIONS_FILE);
    
    let targetKey = proposalId;
    
    // 如果直接键不存在，查找匹配的申请
    if (!applications[proposalId]) {
        for (const appId in applications) {
            const app = applications[appId];
            if (app.proposalId == proposalId) {
                targetKey = appId;
                break;
            }
        }
    }
    
    if (applications[targetKey]) {
        delete applications[targetKey];
        writeJsonFile(PROPOSAL_APPLICATIONS_FILE, applications);
        console.log(`成功删除议案申请 - ID: ${proposalId}`);
        return true;
    }
    
    console.warn(`未找到要删除的议案申请 - ID: ${proposalId}`);
    return false;
}

module.exports = {
    saveProposalSettings,
    getProposalSettings,
    getNextProposalId,
    saveProposalApplication,
    getProposalApplication,
    updateProposalApplication,
    getAllProposalApplications,
    getProposalApplicationsByGuild,
    getProposalApplicationsByStatus,
    deleteProposalApplication
}; 