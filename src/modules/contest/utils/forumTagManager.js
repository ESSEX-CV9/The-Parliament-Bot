const { ChannelType } = require('discord.js');

// 审核状态标签配置
const CONTEST_STATUS_TAGS = {
    PENDING: {
        name: '🔵 待审核',
        emoji: '🔵',
        moderated: false
    },
    MODIFICATION_REQUIRED: {
        name: '🟡 待修改', 
        emoji: '🟡',
        moderated: false
    },
    PENDING_RECHECK: {
        name: '🟠 待再审',
        emoji: '🟠', 
        moderated: false
    },
    APPROVED: {
        name: '🟢 已通过',
        emoji: '🟢',
        moderated: false
    },
    REJECTED: {
        name: '🔴 未通过',
        emoji: '🔴',
        moderated: false
    },
    CANCELLED: {
        name: '⚫ 已撤销',
        emoji: '⚫',
        moderated: false
    },
    CHANNEL_CREATED: {
        name: '🎉 已开启',
        emoji: '🎉',
        moderated: false
    }
};

/**
 * 确保论坛有所需的标签
 * @param {ForumChannel} forumChannel - 论坛频道
 * @returns {object} 标签ID映射
 */
async function ensureContestStatusTags(forumChannel) {
    try {
        if (forumChannel.type !== ChannelType.GuildForum) {
            throw new Error('频道不是论坛类型');
        }

        let currentTags = forumChannel.availableTags; // 使用let而不是const，允许更新
        const tagMap = {};

        // 检查并创建所需标签
        for (const [statusKey, tagConfig] of Object.entries(CONTEST_STATUS_TAGS)) {
            // 查找已存在的标签
            let existingTag = currentTags.find(tag => tag.name === tagConfig.name);
            
            if (!existingTag) {
                // 如果标签不存在，创建新标签
                console.log(`创建新的审核状态标签: ${tagConfig.name}`);
                
                // 更新论坛标签 - 基于当前最新的标签列表
                const updatedTags = [...currentTags, {
                    name: tagConfig.name,
                    emoji: tagConfig.emoji,
                    moderated: tagConfig.moderated
                }];
                
                await forumChannel.setAvailableTags(updatedTags);
                
                // 重新获取更新后的标签列表
                const refreshedChannel = await forumChannel.fetch();
                currentTags = refreshedChannel.availableTags; // 更新当前标签列表
                
                existingTag = currentTags.find(tag => tag.name === tagConfig.name);
                
                if (!existingTag) {
                    throw new Error(`创建标签 ${tagConfig.name} 失败`);
                }
            }
            
            tagMap[statusKey] = existingTag.id;
        }

        console.log('论坛审核状态标签确保完成:', Object.keys(tagMap));
        return tagMap;

    } catch (error) {
        console.error('确保论坛标签时出错:', error);
        throw error;
    }
}

/**
 * 更新帖子的审核状态标签
 * @param {ThreadChannel} thread - 论坛帖子
 * @param {string} newStatus - 新状态
 * @param {object} tagMap - 标签ID映射
 */
async function updateThreadStatusTag(thread, newStatus, tagMap = null) {
    try {
        // 如果没有提供标签映射，重新获取
        if (!tagMap) {
            const forumChannel = thread.parent;
            tagMap = await ensureContestStatusTags(forumChannel);
        }

        // 获取新状态对应的标签ID
        const newTagId = tagMap[newStatus];
        if (!newTagId) {
            throw new Error(`未找到状态 ${newStatus} 对应的标签`);
        }

        // 移除所有审核状态标签，只保留新状态标签
        const currentTags = thread.appliedTags || [];
        const statusTagIds = Object.values(tagMap);
        
        // 过滤掉所有审核状态标签，保留其他标签
        const nonStatusTags = currentTags.filter(tagId => !statusTagIds.includes(tagId));
        
        // 添加新的状态标签
        const newAppliedTags = [...nonStatusTags, newTagId];

        await thread.setAppliedTags(newAppliedTags);
        
        console.log(`帖子 ${thread.id} 状态标签已更新为: ${newStatus}`);
        
    } catch (error) {
        console.error('更新帖子状态标签时出错:', error);
        throw error;
    }
}

/**
 * 获取帖子当前的审核状态
 * @param {ThreadChannel} thread - 论坛帖子
 * @param {object} tagMap - 标签ID映射
 * @returns {string|null} 当前状态
 */
function getThreadCurrentStatus(thread, tagMap) {
    try {
        const currentTags = thread.appliedTags || [];
        
        // 查找当前应用的状态标签
        for (const [status, tagId] of Object.entries(tagMap)) {
            if (currentTags.includes(tagId)) {
                return status;
            }
        }
        
        return null; // 没有找到状态标签
        
    } catch (error) {
        console.error('获取帖子状态时出错:', error);
        return null;
    }
}

/**
 * 根据申请状态获取对应的标签状态
 * @param {string} applicationStatus - 申请状态
 * @returns {string} 标签状态
 */
function getTagStatusFromApplicationStatus(applicationStatus) {
    const statusMapping = {
        'pending': 'PENDING',
        'modification_required': 'MODIFICATION_REQUIRED', 
        'pending_recheck': 'PENDING_RECHECK',
        'approved': 'APPROVED',
        'rejected': 'REJECTED',
        'cancelled': 'CANCELLED',
        'channel_created': 'CHANNEL_CREATED'
    };
    
    return statusMapping[applicationStatus] || 'PENDING';
}

module.exports = {
    CONTEST_STATUS_TAGS,
    ensureContestStatusTags,
    updateThreadStatusTag,
    getThreadCurrentStatus,
    getTagStatusFromApplicationStatus
}; 