const { KeywordDetector } = require('../services/keywordDetector');
const { RateLimiter } = require('../services/rateLimiter');
const { taskManager } = require('../services/taskManager');
const { getAutoCleanupSettings } = require('../../../core/utils/database');

class AutoCleanupMessageHandler {
    constructor() {
        this.keywordDetector = new KeywordDetector();
        this.rateLimiter = new RateLimiter();
    }

    async handleMessage(message) {
        // 忽略机器人消息
        if (message.author.bot) return;

        // 忽略系统消息
        if (message.system) return;

        // 检查是否在服务器中
        if (!message.guild) return;

        const guildId = message.guild.id;

        try {
            // 检查自动清理是否被暂停（由于全服务器扫描）
            if (taskManager.isAutoCleanupPaused(guildId)) {
                return;
            }

            // 获取服务器的自动清理设置
            const settings = await getAutoCleanupSettings(guildId);
            
            // 检查是否启用了自动清理
            if (!settings.isEnabled || !settings.autoCleanupEnabled) {
                return;
            }

            // 检查是否有违禁关键字
            if (!settings.bannedKeywords || settings.bannedKeywords.length === 0) {
                return;
            }

            // 检查频道是否在监控列表中（如果设置了监控频道）
            if (settings.monitorChannels && settings.monitorChannels.length > 0) {
                if (!settings.monitorChannels.includes(message.channel.id)) {
                    return;
                }
            }

            // 检查消息是否包含违禁关键字
            const checkResult = await this.keywordDetector.checkMessageAdvanced(
                message, 
                settings.bannedKeywords
            );

            if (checkResult.shouldDelete) {
                // 删除违规消息
                await this.rateLimiter.execute(async () => {
                    await message.delete();
                });

                console.log(`🗑️ 自动删除违规消息 - 服务器: ${message.guild.name}, 频道: ${message.channel.name}, 作者: ${message.author.tag}, 匹配关键字: ${checkResult.matchedKeywords.join(', ')}`);

                // 可选：发送警告私信给用户
                try {
                    const warningEmbed = {
                        title: '⚠️ 消息已被自动删除',
                        description: `你在服务器 **${message.guild.name}** 的消息因包含违禁内容而被自动删除。`,
                        fields: [
                            {
                                name: '频道',
                                value: `#${message.channel.name}`,
                                inline: true
                            },
                            {
                                name: '匹配的关键字',
                                value: checkResult.matchedKeywords.join(', '),
                                inline: true
                            }
                        ],
                        color: 0xff9900,
                        timestamp: new Date().toISOString()
                    };

                    await message.author.send({ embeds: [warningEmbed] });
                } catch (dmError) {
                    // 如果无法发送私信，忽略错误
                    console.log(`无法向用户 ${message.author.tag} 发送警告私信:`, dmError.message);
                }

                // 可选：在频道发送临时警告消息
                try {
                    const channelWarning = await message.channel.send({
                        content: `⚠️ <@${message.author.id}> 你的消息因包含违禁内容而被删除。`,
                        allowedMentions: { users: [message.author.id] }
                    });

                    // 5秒后删除警告消息
                    setTimeout(async () => {
                        try {
                            await channelWarning.delete();
                        } catch (error) {
                            // 忽略删除失败的错误
                        }
                    }, 5000);
                } catch (channelError) {
                    // 如果无法在频道发送消息，忽略错误
                    console.log(`无法在频道发送警告消息:`, channelError.message);
                }
            }

        } catch (error) {
            console.error(`处理自动清理消息时出错 - Guild: ${guildId}:`, error);
        }
    }
}

const autoCleanupHandler = new AutoCleanupMessageHandler();

module.exports = { autoCleanupHandler }; 