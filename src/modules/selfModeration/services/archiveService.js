// src\modules\selfModeration\services\archiveService.js
const { EmbedBuilder } = require('discord.js');
const { getArchiveChannelSettings } = require('../../../core/utils/database');

/**
 * 归档被删除的消息
 * @param {Client} client - Discord客户端
 * @param {object} messageInfo - 消息信息
 * @param {object} voteData - 投票数据
 * @returns {boolean} 是否成功归档
 */
async function archiveDeletedMessage(client, messageInfo, voteData) {
    try {
        const { guildId, currentReactionCount, targetMessageUrl, initiatorId, type } = voteData;
        
        // 获取归档频道设置
        const archiveSettings = await getArchiveChannelSettings(guildId);
        if (!archiveSettings || !archiveSettings.enabled || !archiveSettings.channelId) {
            console.log(`服务器 ${guildId} 未设置归档频道，跳过归档`);
            return false;
        }
        
        // 获取归档频道
        const archiveChannel = await client.channels.fetch(archiveSettings.channelId);
        if (!archiveChannel) {
            console.error(`归档频道 ${archiveSettings.channelId} 不存在`);
            return false;
        }
        
        // 🔥 根据投票类型调整标题和描述
        const actionType = type === 'delete' ? '删除消息投票' : '禁言用户投票';
        const actionIcon = type === 'delete' ? '🗑️' : '🔇';
        const reasonText = type === 'delete' 
            ? '因达到⚠️反应阈值被自助管理系统删除' 
            : '因禁言用户投票达到阈值被删除';
        
        // 构建归档嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(`📁 消息归档记录 ${actionIcon}`)
            .setDescription(`以下消息${reasonText}`)
            .addFields(
                {
                    name: '📝 原消息内容',
                    value: messageInfo.content || '*（无文字内容或内容为空）*',
                    inline: false
                },
                {
                    name: '👤 消息作者',
                    value: `<@${messageInfo.authorId}> (${messageInfo.author})`,
                    inline: true
                },
                {
                    name: '📍 原消息位置',
                    value: `[跳转到原位置](${targetMessageUrl})`,
                    inline: true
                },
                {
                    name: '⚠️ 反应数量',
                    value: `${currentReactionCount}个（去重后）`,
                    inline: true
                },
                {
                    name: '🚀 发起人',
                    value: `<@${initiatorId}>`,
                    inline: true
                },
                {
                    name: '🕐 删除时间',
                    value: `<t:${Math.floor(Date.now() / 1000)}:f>`,
                    inline: true
                },
                {
                    name: '📋 投票类型',
                    value: actionType,
                    inline: true
                },
                {
                    name: '🔗 消息ID',
                    value: `\`${messageInfo.messageId || '未知'}\``,
                    inline: false
                }
            )
            .setColor(type === 'delete' ? '#FF6B6B' : '#FF8C00') // 🔥 不同类型不同颜色
            .setTimestamp();
        
        // 如果消息有附件，记录附件信息
        if (messageInfo.attachments && messageInfo.attachments.length > 0) {
            const attachmentList = messageInfo.attachments.map(att => 
                `• [${att.name}](${att.url}) (${formatFileSize(att.size)})`
            ).join('\n');
            
            embed.addFields({
                name: '📎 附件',
                value: attachmentList,
                inline: false
            });
        }
        
        // 如果消息有嵌入内容，记录嵌入数量
        if (messageInfo.embeds && messageInfo.embeds.length > 0) {
            embed.addFields({
                name: '🎴 嵌入消息',
                value: `包含 ${messageInfo.embeds.length} 个嵌入消息`,
                inline: false
            });
        }
        
        // 发送归档消息
        await archiveChannel.send({ embeds: [embed] });
        
        console.log(`成功归档消息到频道 ${archiveChannel.name} (${archiveChannel.id})，类型: ${actionType}`);
        return true;
        
    } catch (error) {
        console.error('归档消息时出错:', error);
        return false;
    }
}

/**
 * 格式化文件大小显示
 * @param {number} bytes - 文件大小（字节）
 * @returns {string} 格式化的文件大小
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 检查归档频道是否可用
 * @param {Client} client - Discord客户端
 * @param {string} guildId - 服务器ID
 * @returns {object} {available: boolean, channel: Channel|null, error: string|null}
 */
async function checkArchiveChannelAvailable(client, guildId) {
    try {
        const archiveSettings = await getArchiveChannelSettings(guildId);
        if (!archiveSettings || !archiveSettings.enabled || !archiveSettings.channelId) {
            return {
                available: false,
                channel: null,
                error: '未设置归档频道'
            };
        }
        
        const archiveChannel = await client.channels.fetch(archiveSettings.channelId);
        if (!archiveChannel) {
            return {
                available: false,
                channel: null,
                error: '归档频道不存在'
            };
        }
        
        // 检查机器人权限
        const botMember = archiveChannel.guild.members.me;
        const permissions = archiveChannel.permissionsFor(botMember);
        
        if (!permissions.has('SendMessages')) {
            return {
                available: false,
                channel: archiveChannel,
                error: '机器人无权在归档频道发送消息'
            };
        }
        
        if (!permissions.has('EmbedLinks')) {
            return {
                available: false,
                channel: archiveChannel,
                error: '机器人无权在归档频道发送嵌入消息'
            };
        }
        
        return {
            available: true,
            channel: archiveChannel,
            error: null
        };
        
    } catch (error) {
        console.error('检查归档频道可用性时出错:', error);
        return {
            available: false,
            channel: null,
            error: error.message
        };
    }
}

module.exports = {
    archiveDeletedMessage,
    checkArchiveChannelAvailable,
    formatFileSize
};