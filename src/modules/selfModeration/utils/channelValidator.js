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
        // 如果没有设置允许的频道，默认允许所有频道
        if (!settings || !settings.allowedChannels || settings.allowedChannels.length === 0) {
            console.log('未配置允许的频道，默认允许所有频道');
            return true;
        }
        
        // 检查当前频道是否在允许列表中
        if (settings.allowedChannels.includes(channelId)) {
            console.log(`频道 ${channelId} 在允许列表中`);
            return true;
        }
        
        // 如果频道是论坛帖子，检查其父论坛是否在允许列表中
        if (channel) {
            // 检查是否是论坛帖子 (type 11 = PUBLIC_THREAD, type 12 = PRIVATE_THREAD)
            if ((channel.type === 11 || channel.type === 12) && channel.parent) {
                const parentId = channel.parent.id;
                
                // 检查父频道是否是论坛 (type 15 = GUILD_FORUM)
                if (channel.parent.type === 15 && settings.allowedChannels.includes(parentId)) {
                    console.log(`论坛帖子 ${channelId} 的父论坛 ${parentId} 在允许列表中`);
                    return true;
                }
            }
        }
        
        console.log(`频道 ${channelId} 不在允许列表中`);
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
    checkBotPermissions
};