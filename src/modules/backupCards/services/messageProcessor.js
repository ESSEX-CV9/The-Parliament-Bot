const { AttachmentBuilder } = require('discord.js');
const ContentAnalyzer = require('../utils/contentAnalyzer');
const FileLocator = require('./fileLocator');
const EmbedGenerator = require('../utils/embedGenerator');
const config = require('../config/backupConfig');

class MessageProcessor {
    constructor(client) {
        this.client = client;
        this.contentAnalyzer = new ContentAnalyzer();
        this.fileLocator = new FileLocator();
        this.embedGenerator = new EmbedGenerator();
        
        this.stats = {
            total: 0,
            processed: 0,
            failed: 0,
            files: 0,
            textDescriptions: 0,
            discordLinks: 0,
            skipped: 0
        };
    }

    /**
     * 初始化处理器
     */
    async initialize() {
        try {
            console.log('正在初始化消息处理器...');
            await this.fileLocator.initializeCache();
            console.log('消息处理器初始化完成');
        } catch (error) {
            console.error('初始化消息处理器失败:', error);
            throw error;
        }
    }

    /**
     * 处理单个补卡项目
     */
    async processBackupItem(backupItem, testMode = false, autoArchive = null, allowArchiveInTest = false) {
        try {
            console.log(`开始处理补卡项目: ${backupItem.threadId} - ${backupItem.title}`);
            
            if (!backupItem.cardContents || backupItem.cardContents.length === 0) {
                console.log(`跳过无补卡内容的项目: ${backupItem.threadId}`);
                this.stats.skipped++;
                return { success: true, skipped: true };
            }

            // 获取目标频道
            const targetChannel = await this.getTargetChannel(backupItem.threadId);
            if (!targetChannel) {
                console.error(`无法找到目标频道: ${backupItem.threadId}`);
                this.stats.failed++;
                return { success: false, error: `无法找到频道: ${backupItem.threadId}` };
            }

            // 处理每个补卡内容
            let processedCount = 0;
            let failedCount = 0;
            for (const contentItem of backupItem.cardContents) {
                try {
                    const result = await this.processContentItem(contentItem, backupItem, targetChannel, testMode);
                    if (result.success) {
                        processedCount++;
                        this.updateStats(result.type);
                    } else {
                        this.stats.failed++;
                        failedCount++;
                    }
                    
                    // 控制发送频率
                    if (!testMode) {
                        await this.delay(config.discord.rateLimitDelay);
                    }
                    
                } catch (error) {
                    console.error(`处理补卡内容失败:`, error);
                    this.stats.failed++;
                    failedCount++;
                }
            }

            this.stats.processed++;
            console.log(`完成处理补卡项目: ${backupItem.threadId}, 处理了 ${processedCount}/${backupItem.cardContents.length} 个内容`);
            
            // 检查是否需要归档线程
            const shouldArchive = this.shouldArchiveThread(autoArchive, processedCount, failedCount, testMode, allowArchiveInTest);
            if (shouldArchive) {
                await this.archiveThread(targetChannel, backupItem);
            }
            
            return { success: true, processedCount, archived: shouldArchive };
            
        } catch (error) {
            console.error(`处理补卡项目失败:`, error);
            this.stats.failed++;
            return { success: false, error: error.message };
        }
    }

    /**
     * 处理单个补卡内容
     */
    async processContentItem(contentItem, backupItem, targetChannel, testMode) {
        // 分析内容类型
        const analyzedContent = this.contentAnalyzer.analyzeContent(contentItem.content);
        
        console.log(`处理内容: ${contentItem.content} -> 类型: ${analyzedContent.type}`);

        if (testMode) {
            console.log(`[测试模式] 跳过实际发送，内容类型: ${analyzedContent.type}`);
            return { success: true, type: analyzedContent.type };
        }

        switch (analyzedContent.type) {
            case 'file':
                return await this.processFileContent(analyzedContent, backupItem, targetChannel);
            
            case 'text_description':
                return await this.processTextDescription(analyzedContent, backupItem, targetChannel);
            
            case 'discord_link':
                return await this.processDiscordLink(analyzedContent, backupItem, targetChannel);
            
            case 'empty':
                console.log('跳过空内容');
                return { success: true, type: 'empty', skipped: true };
            
            default:
                return await this.processUnknownContent(analyzedContent, backupItem, targetChannel);
        }
    }

    /**
     * 处理文件内容
     */
    async processFileContent(analyzedContent, backupItem, targetChannel) {
        try {
            // 查找文件
            const fileResults = await this.fileLocator.locateFile(
                analyzedContent.fileName,
                analyzedContent.pathPrefix
            );

            // 生成Embed消息
            const embed = this.embedGenerator.generateFileEmbed(analyzedContent, fileResults, backupItem);

            if (fileResults && fileResults.length > 0) {
                // 文件找到，发送文件
                const file = fileResults[0];
                const attachment = new AttachmentBuilder(file.path, { 
                    name: analyzedContent.fileName 
                });

                await targetChannel.send({
                    embeds: [embed],
                    files: [attachment]
                });

                console.log(`✅ 成功发送文件: ${analyzedContent.fileName}`);
                return { success: true, type: 'file' };
                
            } else {
                // 文件未找到，只发送说明
                await targetChannel.send({
                    embeds: [embed]
                });

                console.log(`⚠️ 文件未找到，发送说明: ${analyzedContent.fileName}`);
                return { success: true, type: 'file_not_found' };
            }
            
        } catch (error) {
            console.error(`处理文件内容失败:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 处理文字描述
     */
    async processTextDescription(analyzedContent, backupItem, targetChannel) {
        try {
            const embed = this.embedGenerator.generateTextDescriptionEmbed(analyzedContent, backupItem);
            
            await targetChannel.send({
                embeds: [embed]
            });

            console.log(`✅ 成功发送文字描述: ${analyzedContent.category}`);
            return { success: true, type: 'text_description' };
            
        } catch (error) {
            console.error(`处理文字描述失败:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 处理Discord链接
     */
    async processDiscordLink(analyzedContent, backupItem, targetChannel) {
        try {
            // 发送说明Embed
            const embed = this.embedGenerator.generateDiscordLinkEmbed(analyzedContent, backupItem);
            
            await targetChannel.send({
                embeds: [embed]
            });

            // 发送链接消息
            const linkMessages = analyzedContent.links.map(link => link).join('\n');
            await targetChannel.send(linkMessages);

            console.log(`✅ 成功发送Discord链接: ${analyzedContent.links.length} 个`);
            return { success: true, type: 'discord_link' };
            
        } catch (error) {
            console.error(`处理Discord链接失败:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 处理未知内容
     */
    async processUnknownContent(analyzedContent, backupItem, targetChannel) {
        try {
            const embed = this.embedGenerator.generateErrorEmbed(
                analyzedContent, 
                backupItem, 
                '无法识别的内容类型'
            );
            
            await targetChannel.send({
                embeds: [embed]
            });

            console.log(`⚠️ 发送未知内容警告: ${analyzedContent.originalContent}`);
            return { success: true, type: 'unknown' };
            
        } catch (error) {
            console.error(`处理未知内容失败:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取目标频道
     */
    async getTargetChannel(threadId) {
        try {
            const channelUrl = `${config.discord.baseUrl}${threadId}`;
            console.log(`尝试获取频道: ${channelUrl}`);
            
            // 直接使用threadId作为频道ID
            const channel = await this.client.channels.fetch(threadId);
            
            if (channel) {
                console.log(`✅ 成功获取频道: ${channel.name || threadId}`);
                return channel;
            } else {
                console.error(`❌ 无法获取频道: ${threadId}`);
                return null;
            }
            
        } catch (error) {
            console.error(`获取频道失败 ${threadId}:`, error);
            return null;
        }
    }

    /**
     * 更新统计信息
     */
    updateStats(type) {
        switch (type) {
            case 'file':
                this.stats.files++;
                break;
            case 'text_description':
                this.stats.textDescriptions++;
                break;
            case 'discord_link':
                this.stats.discordLinks++;
                break;
        }
    }

    /**
     * 获取处理统计
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * 重置统计
     */
    resetStats() {
        this.stats = {
            total: 0,
            processed: 0,
            failed: 0,
            files: 0,
            textDescriptions: 0,
            discordLinks: 0,
            skipped: 0
        };
    }

    /**
     * 延迟函数
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 生成处理报告
     */
    generateReport() {
        const total = this.stats.processed + this.stats.failed + this.stats.skipped;
        const successRate = total > 0 ? Math.round((this.stats.processed / total) * 100) : 0;
        
        return {
            summary: {
                total,
                processed: this.stats.processed,
                failed: this.stats.failed,
                skipped: this.stats.skipped,
                successRate: `${successRate}%`
            },
            details: {
                files: this.stats.files,
                textDescriptions: this.stats.textDescriptions,
                discordLinks: this.stats.discordLinks
            }
        };
    }

    /**
     * 检查是否需要归档线程
     */
    shouldArchiveThread(autoArchive, processedCount, failedCount, testMode, allowArchiveInTest = false) {
        // 测试模式下的归档逻辑
        if (testMode) {
            // 如果明确允许测试模式下归档，则继续检查其他条件
            if (!allowArchiveInTest) {
                return false;
            }
            // 在测试模式下如果允许归档，则跳过消息发送检查，直接检查其他条件
        }

        // 如果参数直接指定了归档设置，使用参数
        if (autoArchive !== null) {
            return autoArchive;
        }

        // 使用配置文件设置
        const archiveConfig = config.discord.autoArchive;
        
        // 检查是否启用了自动归档
        if (!archiveConfig || !archiveConfig.enabled) {
            return false;
        }

        // 如果配置要求只在成功时归档，检查是否有失败的内容
        if (archiveConfig.onlyOnSuccess && failedCount > 0) {
            console.log(`不归档线程：有 ${failedCount} 个内容处理失败`);
            return false;
        }

        // 在测试模式下，如果允许归档，即使没有实际发送内容也可以归档
        if (testMode && allowArchiveInTest) {
            console.log(`🧪 测试模式下执行归档操作`);
            return true;
        }

        // 如果有内容被处理了，就归档
        return processedCount > 0;
    }

    /**
     * 归档线程
     */
    async archiveThread(targetChannel, backupItem) {
        try {
            console.log(`📁 正在归档线程: ${backupItem.threadId} - ${backupItem.title}`);

            // 检查频道是否是线程
            if (!targetChannel.isThread || !targetChannel.isThread()) {
                console.log(`⚠️ 频道 ${backupItem.threadId} 不是线程，跳过归档`);
                return false;
            }

            // 检查机器人权限
            const permissions = targetChannel.permissionsFor(targetChannel.guild.members.me);
            if (!permissions || !permissions.has(['ManageThreads'])) {
                console.log(`⚠️ 机器人缺少管理线程权限，无法归档 ${backupItem.threadId}`);
                return false;
            }

            // 检查线程是否已经归档
            if (targetChannel.archived) {
                console.log(`ℹ️ 线程 ${backupItem.threadId} 已经归档，跳过操作`);
                return true;
            }

            // 归档前延迟，确保最后的消息发送完成
            const archiveConfig = config.discord.autoArchive;
            if (archiveConfig && archiveConfig.delay) {
                await this.delay(archiveConfig.delay);
            }

            // 执行归档
            const reason = (archiveConfig && archiveConfig.reason) || '补卡完成，自动归档';
            await targetChannel.setArchived(true, reason);

            console.log(`✅ 线程已成功归档: ${backupItem.threadId} - ${backupItem.title}`);
            return true;

        } catch (error) {
            console.error(`❌ 归档线程失败 ${backupItem.threadId}:`, error.message);
            
            // 常见错误的友好提示
            if (error.code === 50013) {
                console.log(`💡 提示: 机器人缺少"管理线程"权限`);
            } else if (error.code === 50083) {
                console.log(`💡 提示: 线程可能已经归档或不存在`);
            }
            
            // 归档失败不影响补卡处理成功
            return false;
        }
    }
}

module.exports = MessageProcessor; 