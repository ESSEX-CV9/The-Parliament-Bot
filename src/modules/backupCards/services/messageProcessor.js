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
    async processBackupItem(backupItem, testMode = false) {
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
            for (const contentItem of backupItem.cardContents) {
                try {
                    const result = await this.processContentItem(contentItem, backupItem, targetChannel, testMode);
                    if (result.success) {
                        processedCount++;
                        this.updateStats(result.type);
                    } else {
                        this.stats.failed++;
                    }
                    
                    // 控制发送频率
                    if (!testMode) {
                        await this.delay(config.discord.rateLimitDelay);
                    }
                    
                } catch (error) {
                    console.error(`处理补卡内容失败:`, error);
                    this.stats.failed++;
                }
            }

            this.stats.processed++;
            console.log(`完成处理补卡项目: ${backupItem.threadId}, 处理了 ${processedCount}/${backupItem.cardContents.length} 个内容`);
            
            return { success: true, processedCount };
            
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
}

module.exports = MessageProcessor; 