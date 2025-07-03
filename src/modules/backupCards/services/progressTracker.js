const EmbedGenerator = require('../utils/embedGenerator');

class ProgressTracker {
    constructor(interaction) {
        this.interaction = interaction;
        this.embedGenerator = new EmbedGenerator();
        
        this.currentMessage = null;
        this.isUsingNewMessage = false;
        this.interactionValid = true;
        
        this.startTime = Date.now();
        this.lastUpdateTime = Date.now();
        
        this.progress = {
            currentIndex: 0,
            totalItems: 0,
            processed: 0,
            failed: 0,
            skipped: 0
        };
        
        this.stats = {
            files: 0,
            textDescriptions: 0,
            discordLinks: 0,
            errors: [],
            archived: 0
        };
    }

    /**
     * 初始化进度跟踪
     */
    async initialize(totalItems, startIndex = 0) {
        this.progress.totalItems = totalItems;
        this.progress.currentIndex = startIndex;
        
        const initialMessage = this.generateInitialMessage();
        
        try {
            await this.interaction.editReply(initialMessage);
            console.log('进度跟踪器初始化完成');
        } catch (error) {
            console.error('初始化进度跟踪器失败:', error);
            throw error;
        }
    }

    /**
     * 更新处理进度
     */
    async updateProgress(increment = 1, itemResult = null) {
        this.progress.currentIndex += increment;
        this.lastUpdateTime = Date.now();
        
        // 更新统计信息
        if (itemResult) {
            this.updateItemStats(itemResult);
        }
        
        // 每处理5个项目或到达重要节点时更新消息
        if (this.shouldUpdateMessage()) {
            await this.updateProgressMessage();
        }
    }

    /**
     * 更新项目统计
     */
    updateItemStats(itemResult) {
        if (itemResult.success) {
            if (itemResult.skipped) {
                this.progress.skipped++;
            } else {
                this.progress.processed++;
            }
            
            // 更新类型统计
            if (itemResult.stats) {
                this.stats.files += itemResult.stats.files || 0;
                this.stats.textDescriptions += itemResult.stats.textDescriptions || 0;
                this.stats.discordLinks += itemResult.stats.discordLinks || 0;
            }

            // 更新归档统计
            if (itemResult.archived) {
                this.stats.archived++;
            }
        } else {
            this.progress.failed++;
            
            // 记录错误
            if (itemResult.error) {
                this.stats.errors.push({
                    index: this.progress.currentIndex,
                    error: itemResult.error,
                    timestamp: Date.now()
                });
            }
        }
    }

    /**
     * 判断是否需要更新消息
     */
    shouldUpdateMessage() {
        const timeSinceLastUpdate = Date.now() - this.lastUpdateTime;
        const progressInterval = this.progress.currentIndex % 5 === 0;
        const timeInterval = timeSinceLastUpdate > 10000; // 10秒强制更新
        
        return progressInterval || timeInterval || this.progress.currentIndex === this.progress.totalItems;
    }

    /**
     * 更新进度消息
     */
    async updateProgressMessage() {
        try {
            const progressEmbed = this.embedGenerator.generateProgressEmbed(
                {
                    processed: this.progress.processed,
                    failed: this.progress.failed,
                    files: this.stats.files,
                    textDescriptions: this.stats.textDescriptions,
                    discordLinks: this.stats.discordLinks
                },
                this.progress.currentIndex,
                this.progress.totalItems
            );

            const content = this.generateProgressContent();
            const messageData = {
                content,
                embeds: [progressEmbed]
            };

            const success = await this.updateMessage(messageData);
            if (!success) {
                console.warn('更新进度消息失败，继续处理...');
            }
            
        } catch (error) {
            console.error('更新进度消息时出错:', error);
        }
    }

    /**
     * 生成进度内容文本
     */
    generateProgressContent() {
        const percentage = Math.round((this.progress.currentIndex / this.progress.totalItems) * 100);
        const progressBar = this.generateProgressBar(percentage);
        
        const elapsed = Math.round((Date.now() - this.startTime) / 1000);
        const estimatedTotal = this.progress.currentIndex > 0 ? 
            Math.round((elapsed / this.progress.currentIndex) * this.progress.totalItems) : 0;
        const remaining = Math.max(0, estimatedTotal - elapsed);
        
        return `🔄 **补卡处理进度**\n\n` +
               `${progressBar} ${percentage}%\n\n` +
               `📊 **当前状态**\n` +
               `• 处理中: ${this.progress.currentIndex}/${this.progress.totalItems}\n` +
               `• 已完成: ${this.progress.processed}\n` +
               `• 失败: ${this.progress.failed}\n` +
               `• 跳过: ${this.progress.skipped}\n\n` +
               `⏱️ **时间统计**\n` +
               `• 已用时: ${elapsed}秒\n` +
               `• 预计剩余: ${remaining}秒`;
    }

    /**
     * 生成进度条
     */
    generateProgressBar(percentage) {
        const totalBars = 20;
        const filledBars = Math.round((percentage / 100) * totalBars);
        const emptyBars = totalBars - filledBars;
        
        return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
    }

    /**
     * 生成初始消息
     */
    generateInitialMessage() {
        return {
            content: '🚀 **开始处理补卡项目**\n\n' +
                    '正在初始化处理器...\n' +
                    `总计: ${this.progress.totalItems} 个项目\n` +
                    `开始位置: ${this.progress.currentIndex + 1}`,
            embeds: []
        };
    }

    /**
     * 完成处理
     */
    async completeProcessing(finalStats) {
        try {
            const endTime = Date.now();
            const completionEmbed = this.embedGenerator.generateCompletionEmbed(
                {
                    total: this.progress.totalItems,
                    processed: this.progress.processed,
                    failed: this.progress.failed,
                    files: this.stats.files,
                    textDescriptions: this.stats.textDescriptions,
                    discordLinks: this.stats.discordLinks
                },
                this.startTime,
                endTime
            );

            const finalContent = this.generateCompletionContent(endTime);
            
            await this.updateMessage({
                content: finalContent,
                embeds: [completionEmbed]
            });

            console.log('补卡处理完成，进度报告已发送');
            
        } catch (error) {
            console.error('发送完成报告失败:', error);
        }
    }

    /**
     * 生成完成内容
     */
    generateCompletionContent(endTime) {
        const duration = Math.round((endTime - this.startTime) / 1000);
        const successRate = this.progress.totalItems > 0 ? 
            Math.round((this.progress.processed / this.progress.totalItems) * 100) : 0;
        
        let content = `🎉 **补卡处理已完成！**\n\n` +
                     `📊 **最终统计**\n` +
                     `• 总项目: ${this.progress.totalItems}\n` +
                     `• 成功: ${this.progress.processed}\n` +
                     `• 失败: ${this.progress.failed}\n` +
                     `• 跳过: ${this.progress.skipped}\n` +
                     `• 成功率: ${successRate}%\n\n` +
                     `⏱️ **总用时**: ${duration}秒`;

        // 如果有错误，添加错误摘要
        if (this.stats.errors.length > 0) {
            content += `\n\n⚠️ **错误摘要**: ${this.stats.errors.length} 个错误`;
        }

        return content;
    }

    /**
     * 更新消息（处理交互过期）
     */
    async updateMessage(messageData) {
        // 如果还在使用原始交互
        if (!this.isUsingNewMessage && this.interactionValid) {
            try {
                await this.interaction.editReply(messageData);
                return true;
            } catch (error) {
                if (error.code === 50027) { // Invalid Webhook Token
                    console.log('⚠️ Discord交互token已失效，尝试发送新消息继续更新...');
                    this.interactionValid = false;
                    
                    // 尝试发送新消息
                    if (await this.createNewProgressMessage(messageData)) {
                        return true;
                    }
                    return false;
                }
                console.error('更新交互消息失败:', error);
                return false;
            }
        }
        
        // 使用新消息更新
        if (this.isUsingNewMessage && this.currentMessage) {
            try {
                await this.currentMessage.edit(messageData);
                return true;
            } catch (error) {
                console.error('更新新消息失败:', error);
                return false;
            }
        }
        
        return false;
    }

    /**
     * 创建新的进度消息
     */
    async createNewProgressMessage(messageData) {
        try {
            console.log('🔄 创建新的进度更新消息...');
            
            const newMessageData = {
                ...messageData,
                content: `📢 **补卡进度更新** (原交互已失效，使用新消息继续)\n\n${messageData.content}`
            };
            
            this.currentMessage = await this.interaction.channel.send(newMessageData);
            this.isUsingNewMessage = true;
            
            console.log('✅ 成功创建新的进度更新消息');
            return true;
            
        } catch (error) {
            console.error('创建新进度消息失败:', error);
            return false;
        }
    }

    /**
     * 获取当前进度信息
     */
    getProgress() {
        return {
            ...this.progress,
            stats: { ...this.stats },
            duration: Date.now() - this.startTime,
            percentage: Math.round((this.progress.currentIndex / this.progress.totalItems) * 100)
        };
    }

    /**
     * 获取错误列表
     */
    getErrors() {
        return this.stats.errors.map(error => ({
            ...error,
            relativeTime: Math.round((error.timestamp - this.startTime) / 1000)
        }));
    }

    /**
     * 检查是否仍然有效
     */
    isValid() {
        return this.interactionValid || this.isUsingNewMessage;
    }
}

module.exports = ProgressTracker; 