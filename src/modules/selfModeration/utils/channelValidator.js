// src\modules\selfModeration\utils\channelValidator.js

/**
 * 验证频道是否允许使用自助管理功能
 * @param {string} channelId - 频道ID
 * @param {object} settings - 自助管理设置
 * @param {Channel} channel - Discord频道对象（可选，用于获取父频道信息）
 * @returns {boolean} 是否允许
 */
async function validateChannel(channelId, settings, channel = null) {
    try {
        // 如果没有设置或者没有启用频道限制，默认允许所有频道
        if (!settings || !settings.channelsRestricted) {
            console.log('未启用频道限制，默认允许所有频道');
            return true;
        }
        
        // 如果启用了频道限制但允许列表为空，禁止所有频道
        if (!settings.allowedChannels || settings.allowedChannels.length === 0) {
            console.log('已启用频道限制但允许列表为空，禁止所有频道');
            return false;
        }
        
        // 检查当前频道是否在允许列表中
        if (settings.allowedChannels.includes(channelId)) {
            console.log(`频道 ${channelId} 在允许列表中`);
            return true;
        }
        
        // 🔥 如果频道是线程，检查其父频道是否在允许列表中
        if (channel) {
            // 检查是否是线程 (PUBLIC_THREAD = 11, PRIVATE_THREAD = 12, ANNOUNCEMENT_THREAD = 10)
            const threadTypes = [10, 11, 12]; // 公告线程、公开线程、私有线程
            
            if (threadTypes.includes(channel.type) && channel.parent) {
                const parentId = channel.parent.id;
                const parentType = channel.parent.type;
                
                // 检查父频道是否在允许列表中
                if (settings.allowedChannels.includes(parentId)) {
                    console.log(`线程 ${channelId} 的父频道 ${parentId} (类型: ${getChannelTypeDescription(channel.parent)}) 在允许列表中`);
                    return true;
                } else {
                    console.log(`线程 ${channelId} 的父频道 ${parentId} (类型: ${getChannelTypeDescription(channel.parent)}) 不在允许列表中`);
                }
            }
            
            // 兼容性：保留原有的论坛帖子检查逻辑（虽然上面的逻辑已经包含了）
            if ((channel.type === 11 || channel.type === 12) && channel.parent) {
                const parentId = channel.parent.id;
                
                // 检查父频道是否是论坛并且在允许列表中
                if (channel.parent.type === 15 && settings.allowedChannels.includes(parentId)) {
                    console.log(`论坛帖子 ${channelId} 的父论坛 ${parentId} 在允许列表中`);
                    return true;
                }
            }
        }
        
        console.log(`频道 ${channelId} 及其父频道都不在允许列表中`);
        return false;
        
    } catch (error) {
        console.error('验证频道权限时出错:', error);
        return false;
    }
}

/**
 * 获取频道类型描述
 * @param {Channel} channel - Discord频道对象
 * @returns {string} 频道类型描述
 */
function getChannelTypeDescription(channel) {
    const channelTypes = {
        0: '文字频道',
        2: '语音频道',
        4: '分类频道',
        5: '公告频道',
        10: '公告帖子',
        11: '公开帖子',
        12: '私有帖子',
        13: '舞台频道',
        15: '论坛频道'
    };
    
    return channelTypes[channel.type] || `未知类型(${channel.type})`;
}


/**
 * 获取频道的层级信息（用于调试和日志）
 * @param {Channel} channel - Discord频道对象
 * @returns {string} 频道层级描述
 */
function getChannelHierarchy(channel) {
    if (!channel) return '未知频道';
    
    const channelType = getChannelTypeDescription(channel);
    
    if (channel.parent) {
        const parentType = getChannelTypeDescription(channel.parent);
        return `${channelType} "${channel.name}" (父: ${parentType} "${channel.parent.name}")`;
    } else {
        return `${channelType} "${channel.name}"`;
    }
}

/**
 * 检查机器人在目标频道是否有必要的权限
 * @param {Channel} channel - 目标频道
 * @param {GuildMember} botMember - 机器人成员对象
 * @param {string} action - 需要执行的操作 ('delete' 或 'mute')
 * @returns {object} {hasPermission: boolean, missingPermissions: string[]}
 */
function checkBotPermissions(channel, botMember, action) {
    try {
        const permissions = channel.permissionsFor(botMember);
        const missingPermissions = [];
        
        if (!permissions) {
            return {
                hasPermission: false,
                missingPermissions: ['无法获取频道权限']
            };
        }
        
        // 检查基础权限
        if (!permissions.has('ViewChannel')) {
            missingPermissions.push('查看频道');
        }
        
        if (!permissions.has('SendMessages')) {
            missingPermissions.push('发送消息');
        }
        
        // 根据操作检查特定权限
        if (action === 'delete') {
            if (!permissions.has('ManageMessages')) {
                missingPermissions.push('管理消息');
            }
        } else if (action === 'serious_mute') {
            if (!permissions.has('ManageChannels')) {
                missingPermissions.push('ManageChannels（管理频道）');
            }
        } else if (action === 'mute') {
            if (!permissions.has('ModerateMembers')) {
                missingPermissions.push('管理成员（禁言）');
            }
        }
        
        return {
            hasPermission: missingPermissions.length === 0,
            missingPermissions
        };
        
    } catch (error) {
        console.error('检查机器人权限时出错:', error);
        return {
            hasPermission: false,
            missingPermissions: ['权限检查失败']
        };
    }
}

module.exports = {
    validateChannel,
    getChannelTypeDescription,
    checkBotPermissions,
    getChannelHierarchy
};