const fs = require('fs').promises;
const path = require('path');

// 数据文件路径
const DATA_DIR = path.join(__dirname);
const ELECTIONS_FILE = path.join(DATA_DIR, 'elections.json');
const REGISTRATIONS_FILE = path.join(DATA_DIR, 'registrations.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const ELECTION_PERMISSIONS_FILE = path.join(DATA_DIR, 'electionPermissions.json');

// 确保数据目录和文件存在
async function ensureDataFiles() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
    
    const files = [ELECTIONS_FILE, REGISTRATIONS_FILE, VOTES_FILE, ELECTION_PERMISSIONS_FILE];
    for (const file of files) {
        try {
            await fs.access(file);
        } catch {
            await fs.writeFile(file, '{}', 'utf8');
        }
    }
}

// 通用JSON文件读取函数
async function readJsonFile(filePath) {
    try {
        await ensureDataFiles();
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`读取文件失败 ${filePath}:`, error);
        return {};
    }
}

// 通用JSON文件写入函数  
async function writeJsonFile(filePath, data) {
    try {
        await ensureDataFiles();
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`写入文件失败 ${filePath}:`, error);
        throw error;
    }
}

// 选举数据操作
const ElectionData = {
    async getAll() {
        return await readJsonFile(ELECTIONS_FILE);
    },
    
    async getById(electionId) {
        const elections = await this.getAll();
        return elections[electionId] || null;
    },
    
    async getByGuild(guildId) {
        const elections = await this.getAll();
        return Object.values(elections).filter(election => election.guildId === guildId);
    },
    
    async create(electionData) {
        const elections = await this.getAll();
        elections[electionData.electionId] = {
            ...electionData,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await writeJsonFile(ELECTIONS_FILE, elections);
        return elections[electionData.electionId];
    },
    
    async update(electionId, updates) {
        const elections = await this.getAll();
        if (elections[electionId]) {
            elections[electionId] = {
                ...elections[electionId],
                ...updates,
                updatedAt: new Date().toISOString()
            };
            await writeJsonFile(ELECTIONS_FILE, elections);
        }
        return elections[electionId];
    },
    
    async getByGuildAndStatus(guildId, status) {
        const elections = await this.getAll();
        return Object.values(elections).filter(
            election => election.guildId === guildId && election.status === status
        );
    },

    async getActiveElectionByGuild(guildId) {
        const elections = await this.getAll();
        return Object.values(elections).find(
            election => election.guildId === guildId && 
            ['setup', 'registration', 'registration_ended', 'voting'].includes(election.status)
        );
    }
};

// 报名数据操作
const RegistrationData = {
    async getAll() {
        return await readJsonFile(REGISTRATIONS_FILE);
    },
    
    async getByElection(electionId) {
        const registrations = await this.getAll();
        return Object.values(registrations).filter(
            reg => reg.electionId === electionId && reg.status === 'active'
        );
    },
    
    async getByUserAndElection(userId, electionId) {
        const registrations = await this.getAll();
        const regId = `reg_${electionId}_${userId}`;
        const registration = registrations[regId];
        
        // 只返回活跃状态的报名
        if (registration && registration.status === 'active') {
            return registration;
        }
        return null;
    },
    
    async create(registrationData) {
        const registrations = await this.getAll();
        const regId = `reg_${registrationData.electionId}_${registrationData.userId}`;
        registrations[regId] = {
            registrationId: regId,
            ...registrationData,
            status: 'active',
            registeredAt: new Date().toISOString(),
            lastModifiedAt: new Date().toISOString()
        };
        await writeJsonFile(REGISTRATIONS_FILE, registrations);
        return registrations[regId];
    },
    
    async update(registrationId, updates) {
        const registrations = await this.getAll();
        if (registrations[registrationId]) {
            registrations[registrationId] = {
                ...registrations[registrationId],
                ...updates,
                lastModifiedAt: new Date().toISOString()
            };
            await writeJsonFile(REGISTRATIONS_FILE, registrations);
        }
        return registrations[registrationId];
    },

    async withdraw(registrationId) {
        return await this.update(registrationId, { status: 'withdrawn' });
    },

    async getByPosition(electionId, positionId, choiceType = 'first') {
        const registrations = await this.getByElection(electionId);
        const fieldName = choiceType === 'first' ? 'firstChoicePosition' : 'secondChoicePosition';
        return registrations.filter(reg => reg[fieldName] === positionId);
    },

    // 新增：候选人管理相关方法
    async getByUserAndElectionWithAllStatuses(userId, electionId) {
        const registrations = await this.getAll();
        const regId = `reg_${electionId}_${userId}`;
        return registrations[regId] || null;
    },

    async rejectCandidate(registrationId, reason, operatorId) {
        return await this.update(registrationId, { 
            status: 'rejected',
            rejectedAt: new Date().toISOString(),
            rejectedBy: operatorId,
            rejectedReason: reason
        });
    },

    async revokeCandidate(registrationId, reason, operatorId) {
        return await this.update(registrationId, { 
            status: 'revoked',
            revokedAt: new Date().toISOString(),
            revokedBy: operatorId,
            revokedReason: reason
        });
    },

    async setIntroductionMessage(registrationId, messageId, channelId) {
        return await this.update(registrationId, {
            introductionMessageId: messageId,
            introductionChannelId: channelId
        });
    }
};

// 投票数据操作
const VoteData = {
    async getAll() {
        return await readJsonFile(VOTES_FILE);
    },
    
    async getByElection(electionId) {
        const votes = await this.getAll();
        return Object.values(votes).filter(vote => vote.electionId === electionId);
    },
    
    async getById(voteId) {
        const votes = await this.getAll();
        return votes[voteId] || null;
    },
    
    async create(voteData) {
        const votes = await this.getAll();
        votes[voteData.voteId] = {
            ...voteData,
            votes: {},
            createdAt: new Date().toISOString()
        };
        await writeJsonFile(VOTES_FILE, votes);
        return votes[voteData.voteId];
    },
    
    async addVote(voteId, voterId, candidateIds) {
        const votes = await this.getAll();
        if (votes[voteId]) {
            if (!votes[voteId].votes) {
                votes[voteId].votes = {};
            }
            votes[voteId].votes[voterId] = candidateIds;
            await writeJsonFile(VOTES_FILE, votes);
        }
        return votes[voteId];
    },

    async hasUserVoted(voteId, userId) {
        const voteData = await this.getById(voteId);
        return voteData && voteData.votes && voteData.votes[userId] !== undefined;
    },

    async removeUserVote(voteId, userId) {
        const votes = await this.getAll();
        if (votes[voteId] && votes[voteId].votes && votes[voteId].votes[userId]) {
            const removedVote = votes[voteId].votes[userId];
            delete votes[voteId].votes[userId];
            await writeJsonFile(VOTES_FILE, votes);
            return removedVote;
        }
        return null;
    },

    async getUserVotesInElection(electionId, userId) {
        const votes = await this.getByElection(electionId);
        const userVotes = [];
        
        for (const vote of votes) {
            if (vote.votes && vote.votes[userId]) {
                userVotes.push({
                    voteId: vote.voteId,
                    positionId: vote.positionId,
                    positionName: vote.positionName,
                    candidateIds: vote.votes[userId],
                    candidates: vote.candidates.filter(c => vote.votes[userId].includes(c.userId))
                });
            }
        }
        
        return userVotes;
    },

    async removeUserVotesFromElection(electionId, userId) {
        const votes = await this.getAll();
        const removedVotes = [];
        
        for (const [voteId, voteData] of Object.entries(votes)) {
            if (voteData.electionId === electionId && voteData.votes && voteData.votes[userId]) {
                removedVotes.push({
                    voteId: voteId,
                    positionId: voteData.positionId,
                    positionName: voteData.positionName,
                    candidateIds: voteData.votes[userId],
                    candidates: voteData.candidates.filter(c => voteData.votes[userId].includes(c.userId))
                });
                delete voteData.votes[userId];
            }
        }
        
        if (removedVotes.length > 0) {
            await writeJsonFile(VOTES_FILE, votes);
        }
        
        return removedVotes;
    }
};

// 新增：选举权限配置操作
const ElectionPermissions = {
    async getAll() {
        return await readJsonFile(ELECTION_PERMISSIONS_FILE);
    },
    
    async getByGuild(guildId) {
        const permissions = await this.getAll();
        return permissions[guildId] || {
            registrationRoles: [],
            votingRoles: [],
            notificationRoles: {
                registration: null,
                voting: null
            }
        };
    },
    
    async saveRegistrationRoles(guildId, roleIds) {
        const permissions = await this.getAll();
        if (!permissions[guildId]) {
            permissions[guildId] = {
                registrationRoles: [],
                votingRoles: [],
                notificationRoles: { registration: null, voting: null }
            };
        }
        permissions[guildId].registrationRoles = roleIds;
        permissions[guildId].updatedAt = new Date().toISOString();
        await writeJsonFile(ELECTION_PERMISSIONS_FILE, permissions);
        return permissions[guildId];
    },
    
    async saveVotingRoles(guildId, roleIds) {
        const permissions = await this.getAll();
        if (!permissions[guildId]) {
            permissions[guildId] = {
                registrationRoles: [],
                votingRoles: [],
                notificationRoles: { registration: null, voting: null }
            };
        }
        permissions[guildId].votingRoles = roleIds;
        permissions[guildId].updatedAt = new Date().toISOString();
        await writeJsonFile(ELECTION_PERMISSIONS_FILE, permissions);
        return permissions[guildId];
    },
    
    async clearRegistrationRoles(guildId) {
        return await this.saveRegistrationRoles(guildId, []);
    },
    
    async clearVotingRoles(guildId) {
        return await this.saveVotingRoles(guildId, []);
    },
    
    async saveNotificationRoles(guildId, phase, roleId) {
        const permissions = await this.getAll();
        if (!permissions[guildId]) {
            permissions[guildId] = {
                registrationRoles: [],
                votingRoles: [],
                notificationRoles: { registration: null, voting: null }
            };
        }
        
        if (!permissions[guildId].notificationRoles) {
            permissions[guildId].notificationRoles = { registration: null, voting: null };
        }
        
        permissions[guildId].notificationRoles[phase] = roleId;
        permissions[guildId].updatedAt = new Date().toISOString();
        await writeJsonFile(ELECTION_PERMISSIONS_FILE, permissions);
        return permissions[guildId];
    },
    
    async clearNotificationRole(guildId, phase) {
        return await this.saveNotificationRoles(guildId, phase, null);
    }
};

module.exports = {
    ElectionData,
    RegistrationData, 
    VoteData,
    ElectionPermissions,
    ensureDataFiles
}; 