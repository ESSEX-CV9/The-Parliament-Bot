// src/modules/proposal/utils/forumTagManager.js
const { ChannelType } = require('discord.js');

// 议案审核状态标签配置（简化版，避免标签过多）
const PROPOSAL_STATUS_TAGS = {
    PENDING: {
        name: '🔵待审核',
        emoji: '🔵',
        moderated: false
    },
    MODIFICATION_REQUIRED: {
        name: '🟡需要修改', 
        emoji: '🟡',
        moderated: false
    },
    APPROVED: {
        name: '🟢已通过',
        emoji: '🟢',
        moderated: false
    },
    REJECTED: {
        name: '🔴未通过',
        emoji: '🔴',
        moderated: false
    },
    PUBLISHED: {
        name: '✅已发布',
        emoji: '✅',
        moderated: false
    }
};

/**
 * 确保论坛有所需的标签
 * @param {ForumChannel} forumChannel - 论坛频道
 * @returns {object} 标签ID映射
 */
async function ensureProposalStatusTags(forumChannel) {
    try {
        if (forumChannel.type !== ChannelType.GuildForum) {
            throw new Error('频道不是论坛类型');
        }

        // 先刷新频道信息以获取最新的标签列表
        const refreshedChannel = await forumChannel.fetch();
        let currentTags = refreshedChannel.availableTags;
        const tagMap = {};
        const maxTags = 20; // Discord论坛标签数量限制
        const requiredTagsCount = Object.keys(PROPOSAL_STATUS_TAGS).length;
        
        console.log(`论坛标签状态检查 - 频道: ${forumChannel.name}, 当前标签数: ${currentTags.length}, 需要创建: ${requiredTagsCount}, 最大限制: ${maxTags}`);
        
        // 先检查所有已存在的标签
        for (const [statusKey, tagConfig] of Object.entries(PROPOSAL_STATUS_TAGS)) {
            const existingTag = currentTags.find(tag => tag.name === tagConfig.name);
            if (existingTag) {
                tagMap[statusKey] = existingTag.id;
                console.log(`✅ 找到已存在标签: ${tagConfig.name} (ID: ${existingTag.id})`);
            }
        }
        
        // 然后处理缺失的标签
        const missingTags = [];
        for (const [statusKey, tagConfig] of Object.entries(PROPOSAL_STATUS_TAGS)) {
            if (!tagMap[statusKey]) {
                missingTags.push({ statusKey, tagConfig });
            }
        }
        
        if (missingTags.length === 0) {
            console.log('所有议案审核标签都已存在，无需创建新标签');
            return tagMap;
        }
        
        console.log(`需要创建 ${missingTags.length} 个标签:`, missingTags.map(t => t.tagConfig.name));
        
        // 检查是否有足够空间创建所需标签
        if (currentTags.length + missingTags.length > maxTags) {
            const availableSpace = maxTags - currentTags.length;
            console.error(`论坛标签空间不足 - 当前: ${currentTags.length}, 需要: ${missingTags.length}, 可用: ${availableSpace}`);
            
            const errorMessage = `❌ 论坛标签数量不足！\n\n**当前状态：**\n• 现有标签：${currentTags.length} 个\n• 需要创建：${missingTags.length} 个议案审核标签\n• 可用空间：${availableSpace} 个\n• Discord限制：最多 ${maxTags} 个标签\n\n**解决方案：**\n请手动删除 ${missingTags.length - availableSpace} 个不需要的论坛标签，然后重试。\n\n**需要创建的标签：**\n${missingTags.map(t => `• ${t.tagConfig.name}`).join('\n')}`;
            
            throw new Error(errorMessage);
        }
        
        // 逐个创建缺失的标签
        for (const { statusKey, tagConfig } of missingTags) {
            try {
                console.log(`尝试创建议案审核标签: ${tagConfig.name}`);
                
                await createSingleTag(forumChannel, tagConfig, tagMap, statusKey);
                
            } catch (tagError) {
                console.error(`创建标签 ${tagConfig.name} 失败:`, tagError);
                
                // 如果是标签名称重复错误，重新检查标签
                if (tagError.code === 40061 || tagError.message?.includes('Tag names must be unique')) {
                    console.log(`标签名称重复，重新检查: ${tagConfig.name}`);
                    
                    // 重新获取最新的标签列表
                    const reRefreshedChannel = await forumChannel.fetch();
                    const updatedTags = reRefreshedChannel.availableTags;
                    const existingTag = updatedTags.find(tag => tag.name === tagConfig.name);
                    
                    if (existingTag) {
                        tagMap[statusKey] = existingTag.id;
                        console.log(`✅ 发现已存在标签: ${tagConfig.name} (ID: ${existingTag.id})`);
                        continue; // 继续处理下一个标签
                    } else {
                        console.error(`标签重复错误但未找到对应标签: ${tagConfig.name}`);
                        throw new Error(`❌ 创建标签"${tagConfig.name}"失败：标签名称重复但无法找到已存在的标签`);
                    }
                }
                
                // 处理其他类型的错误
                if (tagError.code === 50013) {
                    throw new Error(`❌ 权限不足！机器人没有管理论坛标签的权限。请确保机器人在频道 ${forumChannel.name} 中具有"管理频道"权限。`);
                } else if (tagError.code === 50035) {
                    throw new Error(`❌ 标签名称无效！标签"${tagConfig.name}"可能包含不支持的字符或过长。`);
                } else {
                    throw new Error(`❌ 创建标签"${tagConfig.name}"失败：${tagError.message || '未知错误'}`);
                }
            }
        }

        console.log('论坛议案审核状态标签确保完成:', Object.keys(tagMap));
        return tagMap;

    } catch (error) {
        console.error('确保论坛标签时出错:', error);
        throw error;
    }
}

/**
 * 创建单个标签的辅助函数
 * @param {ForumChannel} forumChannel - 论坛频道
 * @param {Object} tagConfig - 标签配置
 * @param {Object} tagMap - 标签映射对象
 * @param {string} statusKey - 状态键
 */
async function createSingleTag(forumChannel, tagConfig, tagMap, statusKey) {
    // 获取当前最新的标签列表
    const currentChannel = await forumChannel.fetch();
    const currentTags = currentChannel.availableTags;
    
    // 再次检查标签是否已存在（防止并发创建）
    const existingTag = currentTags.find(tag => tag.name === tagConfig.name);
    if (existingTag) {
        tagMap[statusKey] = existingTag.id;
        console.log(`✅ 标签已存在（并发检查）: ${tagConfig.name} (ID: ${existingTag.id})`);
        return;
    }
    
    // 创建新标签
    const updatedTags = [...currentTags, {
        name: tagConfig.name,
        emoji: tagConfig.emoji,
        moderated: tagConfig.moderated
    }];
    
    await forumChannel.setAvailableTags(updatedTags);
    
    // 等待确保标签创建完成
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 重新获取更新后的标签列表
    const refreshedChannel = await forumChannel.fetch();
    const refreshedTags = refreshedChannel.availableTags;
    
    // 查找刚创建的标签
    let newTag = refreshedTags.find(tag => tag.name === tagConfig.name);
    
    if (!newTag) {
        // 尝试更灵活的匹配
        newTag = refreshedTags.find(tag => 
            tag.name.includes(tagConfig.name.split(' ')[1]) || 
            tag.name.includes(tagConfig.emoji)
        );
    }
    
    if (!newTag) {
        throw new Error(`标签创建后无法找到：${tagConfig.name}`);
    }
    
    tagMap[statusKey] = newTag.id;
    console.log(`✅ 成功创建标签: ${tagConfig.name} (ID: ${newTag.id})`);
}

/**
 * 更新帖子的审核状态标签
 * @param {ThreadChannel} thread - 论坛帖子
 * @param {string} newStatus - 新状态
 * @param {object} tagMap - 标签ID映射
 */
async function updateProposalThreadStatusTag(thread, newStatus, tagMap) {
    try {
        if (!thread.appliedTags) {
            console.warn('论坛帖子不支持标签');
            return;
        }

        const newTagId = tagMap[newStatus];
        if (!newTagId) {
            console.warn(`未找到状态 ${newStatus} 的标签ID`);
            return;
        }

        // 移除所有现有的状态标签
        const statusTagIds = Object.values(tagMap);
        const nonStatusTags = thread.appliedTags.filter(tagId => !statusTagIds.includes(tagId));
        
        // 添加新的状态标签
        const newTags = [...nonStatusTags, newTagId];
        
        await thread.setAppliedTags(newTags);
        console.log(`议案帖子标签已更新 - 帖子: ${thread.id}, 新状态: ${newStatus}`);

    } catch (error) {
        console.error('更新议案帖子标签时出错:', error);
        throw error;
    }
}

/**
 * 根据申请状态获取对应的标签状态
 * @param {string} applicationStatus - 申请状态
 * @returns {string} 标签状态
 */
function getTagStatusFromProposalStatus(applicationStatus) {
    const statusMapping = {
        'pending': 'PENDING',
        'modification_required': 'MODIFICATION_REQUIRED',
        'pending_recheck': 'MODIFICATION_REQUIRED', // 映射到需要修改
        'approved': 'APPROVED',
        'rejected': 'REJECTED',
        'cancelled': 'REJECTED', // 映射到未通过
        'published': 'PUBLISHED'
    };
    
    return statusMapping[applicationStatus] || 'PENDING';
}

/**
 * 获取状态标签的显示配置
 * @param {string} status - 状态
 * @returns {object} 标签配置
 */
function getProposalStatusTagConfig(status) {
    return PROPOSAL_STATUS_TAGS[status] || PROPOSAL_STATUS_TAGS.PENDING;
}

/**
 * 批量确保多个论坛的标签
 * @param {ForumChannel[]} forumChannels - 论坛频道数组
 * @returns {object} 每个论坛的标签映射
 */
async function batchEnsureProposalStatusTags(forumChannels) {
    const results = {};
    
    for (const forum of forumChannels) {
        try {
            results[forum.id] = await ensureProposalStatusTags(forum);
        } catch (error) {
            console.error(`为论坛 ${forum.id} 确保标签时出错:`, error);
            results[forum.id] = null;
        }
    }
    
    return results;
}

/**
 * 检查论坛是否已有议案状态标签
 * @param {ForumChannel} forumChannel - 论坛频道
 * @returns {boolean} 是否已有标签
 */
function hasProposalStatusTags(forumChannel) {
    if (forumChannel.type !== ChannelType.GuildForum) {
        return false;
    }
    
    const currentTags = forumChannel.availableTags;
    const requiredTagNames = Object.values(PROPOSAL_STATUS_TAGS).map(tag => tag.name);
    
    // 检查是否至少有一个必需的标签存在
    return requiredTagNames.some(tagName => 
        currentTags.some(tag => tag.name === tagName)
    );
}

/**
 * 获取帖子当前的议案状态
 * @param {ThreadChannel} thread - 论坛帖子
 * @param {object} tagMap - 标签ID映射
 * @returns {string|null} 当前状态
 */
function getCurrentProposalStatus(thread, tagMap) {
    if (!thread.appliedTags || thread.appliedTags.length === 0) {
        return null;
    }
    
    // 查找匹配的状态标签
    for (const [status, tagId] of Object.entries(tagMap)) {
        if (thread.appliedTags.includes(tagId)) {
            return status;
        }
    }
    
    return null;
}

module.exports = {
    PROPOSAL_STATUS_TAGS,
    ensureProposalStatusTags,
    updateProposalThreadStatusTag,
    getTagStatusFromProposalStatus,
    getProposalStatusTagConfig,
    batchEnsureProposalStatusTags,
    hasProposalStatusTags,
    getCurrentProposalStatus
}; 