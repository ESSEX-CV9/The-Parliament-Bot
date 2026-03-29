/**
 * 负责管理长时间运行命令的进度更新，通过发送公开消息来绕过15分钟的交互限制。
 */
class PublicProgressManager {
    /**
     * @param {import('discord.js').CommandInteraction} interaction 初始的命令交互
     */
    constructor(interaction) {
        this.interaction = interaction;
        this.channel = interaction.channel;
        this.startTime = Date.now();
        this.lastUpdateTime = 0;
        this.updateThrottleMs = 5000; // 默认5秒更新一次
        this.progressMessage = null;
        this.isInitialized = false;
    }

    /**
     * 初始化进度管理器。
     * 会先回复一个临时消息，然后发送一个公开的进度消息。
     * @param {string} initialContent 初始的公开消息内容
     */
    async initialize(initialContent = '🔄 任务正在初始化...') {
        if (this.isInitialized) return;

        try {
            // 确保交互已被延迟
            if (!this.interaction.deferred) {
                await this.interaction.deferReply({ ephemeral: true });
            }
            
            // 回复一个临时消息确认收到命令
            await this.interaction.editReply({
                content: '🚀 任务已启动！进度更新将在此频道中公开显示。'
            });

            // 发送第一条公开进度消息
            this.progressMessage = await this.channel.send({
                content: this.formatMessage(initialContent)
            });

            this.isInitialized = true;
            console.log(`公开进度消息已初始化，ID: ${this.progressMessage.id}`);
        } catch (error) {
            console.error('初始化公开进度消息失败:', error);
            this.isInitialized = false;
            // 如果失败，至少尝试回复一个错误
            if (!this.interaction.replied) {
                await this.interaction.followUp({ content: '❌ 启动任务失败，无法发送进度消息。', ephemeral: true });
            }
        }
    }

    /**
     * 更新进度消息。
     * @param {string} message 新的进度内容
     */
    async update(message) {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateThrottleMs) {
            return;
        }
        this.lastUpdateTime = now;

        if (!this.isInitialized) {
            console.warn('进度管理器未初始化，无法更新。');
            return;
        }

        const content = this.formatMessage(message);
        try {
            await this.progressMessage.edit({ content });
        } catch (error) {
            console.error('更新公开进度消息失败:', error);
            // 如果消息被删了，尝试重新发送
            if (error.code === 10008) { // Unknown Message
                try {
                    this.progressMessage = await this.channel.send({ content });
                } catch (sendError) {
                    console.error('重新发送进度消息也失败了:', sendError);
                }
            }
        }
    }

    /**
     * 标记任务完成。
     * @param {string} summary 最终的总结信息
     */
    async finish(summary) {
        if (!this.isInitialized) {
            // 如果从未成功初始化，则尝试通过原始交互回复
            await this.interaction.followUp({ content: `✅ **任务完成**\n\n${summary}`, ephemeral: true });
            return;
        }

        const content = `✅ **任务完成** ${this.getElapsedTime(true)}\n\n${summary}`;
        try {
            await this.progressMessage.edit({ content });
        } catch (error) {
            console.error('完成任务消息更新失败:', error);
            // 最后尝试发送一条新消息
            await this.channel.send({ content });
        }
    }

    /**
     * 发送错误信息。
     * @param {string} errorMessage 错误详情
     */
    async sendError(errorMessage) {
        const content = `❌ **任务失败**\n\n${errorMessage}`;
        if (this.isInitialized && this.progressMessage) {
            try {
                await this.progressMessage.edit({ content });
            } catch (error) {
                await this.channel.send({ content });
            }
        } else {
            // 如果初始化失败，则通过交互回复
            await this.interaction.followUp({ content, ephemeral: true });
        }
    }
    
    /**
     * 格式化消息，添加时间戳。
     * @param {string} message
     * @returns {string}
     * @private
     */
    formatMessage(message) {
        return `🔄 **任务进行中** ${this.getElapsedTime()}\n\n${message}`;
    }

    /**
     * 获取已用时间字符串。
     * @param {boolean} isFinal 是否是最后一次调用
     * @returns {string}
     * @private
     */
    getElapsedTime(isFinal = false) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        const prefix = isFinal ? '⏱️ 总用时' : '⏱️';
        return `${prefix}: ${minutes}:${seconds}`;
    }
}

module.exports = PublicProgressManager;