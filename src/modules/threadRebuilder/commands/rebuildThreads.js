const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const JsonReader = require('../services/jsonReader');
const ThreadRebuilder = require('../services/threadRebuilder');
const path = require('path');

const data = new SlashCommandBuilder()
    .setName('重建帖子')
    .setDescription('从JSON备份文件重建Discord帖子（管理员专用）')
    .addChannelOption(option =>
        option.setName('目标论坛')
            .setDescription('要重建到的论坛频道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildForum)
    )
    .addStringOption(option =>
        option.setName('json文件名')
            .setDescription('指定要重建的JSON文件名（不含扩展名，为空则重建所有文件）')
            .setRequired(false)
    )
    .addBooleanOption(option =>
        option.setName('使用webhook')
            .setDescription('是否使用Webhook模拟原作者发送消息（默认：是）')
            .setRequired(false)
    );

// 进度管理器
class ProgressManager {
    constructor(interaction) {
        this.interaction = interaction;
        this.startTime = Date.now();
        this.currentFile = '';
        this.currentProgress = '';
    }
    
    async updateProgress(message) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const timeStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`;
        
        try {
            await this.interaction.editReply({
                content: `🔄 **帖子重建进行中** ⏱️ ${timeStr}\n\n${message}`
            });
        } catch (error) {
            console.error('更新进度失败:', error);
        }
    }
    
    async complete(summary) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const timeStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`;
        
        try {
            await this.interaction.editReply({
                content: `✅ **帖子重建完成** ⏱️ 总用时: ${timeStr}\n\n${summary}`
            });
        } catch (error) {
            console.error('完成更新失败:', error);
        }
    }
}

async function execute(interaction) {
    try {
        // 检查管理员权限
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        const targetForum = interaction.options.getChannel('目标论坛');
        const specificFile = interaction.options.getString('json文件名');
        const useWebhook = interaction.options.getBoolean('使用webhook') !== false; // 默认为真
        
        // 验证目标论坛
        if (targetForum.type !== ChannelType.GuildForum) {
            return interaction.reply({
                content: '❌ 指定的频道不是论坛频道！',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 延迟回复开始处理
        await interaction.deferReply({ ephemeral: true });
        
        const progressManager = new ProgressManager(interaction);
        
        try {
            // 1. 读取JSON文件
            await progressManager.updateProgress('📂 正在扫描JSON文件...');
            
            const jsonReader = new JsonReader();
            const jsonFiles = await jsonReader.getJsonFiles(specificFile);
            
            if (jsonFiles.length === 0) {
                await progressManager.complete('❌ 没有找到要处理的JSON文件！');
                return;
            }
            
            await progressManager.updateProgress(`📝 找到 ${jsonFiles.length} 个JSON文件，开始处理...`);
            
            // 2. 初始化帖子重建器
            const threadRebuilder = new ThreadRebuilder(targetForum, useWebhook);
            const results = [];
            
            // 3. 逐个处理JSON文件
            for (let i = 0; i < jsonFiles.length; i++) {
                const jsonFile = jsonFiles[i];
                const progress = `[${i + 1}/${jsonFiles.length}]`;
                
                try {
                    await progressManager.updateProgress(
                        `${progress} 正在处理: ${jsonFile.name}\n` +
                        `📊 处理进度: ${Math.round((i / jsonFiles.length) * 100)}%`
                    );
                    
                    // 读取并解析JSON数据
                    const threadData = await jsonReader.readThreadData(jsonFile.path);
                    
                    // 重建帖子
                    const result = await threadRebuilder.rebuildThread(threadData, (status) => {
                        // 异步更新进度，不阻塞主流程
                        progressManager.updateProgress(
                            `${progress} 正在处理: ${jsonFile.name}\n` +
                            `📊 文件进度: ${Math.round((i / jsonFiles.length) * 100)}%\n` +
                            `🔄 当前操作: ${status}`
                        ).catch(err => console.log('进度更新失败:', err.message));
                    });
                    
                    results.push({
                        fileName: jsonFile.name,
                        success: true,
                        threadId: result.threadId,
                        messagesCount: result.messagesProcessed,
                        ...result
                    });
                    
                } catch (error) {
                    console.error(`处理文件 ${jsonFile.name} 时出错:`, error);
                    results.push({
                        fileName: jsonFile.name,
                        success: false,
                        error: error.message
                    });
                }
                
                // 文件间稍作延迟，避免过快请求
                if (i < jsonFiles.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            // 4. 生成总结报告
            const summary = generateSummary(results);
            await progressManager.complete(summary);
            
        } catch (error) {
            console.error('重建帖子过程中发生错误:', error);
            await progressManager.complete(`❌ 重建过程发生错误: ${error.message}`);
        }
        
    } catch (error) {
        console.error('重建帖子时发生错误:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ 重建过程发生错误: ${error.message}`
                });
            } else {
                await interaction.reply({
                    content: `❌ 重建过程发生错误: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (e) {
            console.error('回复错误消息失败:', e);
        }
    }
}

function generateSummary(results) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    let summary = `📊 **重建结果汇总**\n\n`;
    summary += `✅ 成功: ${successful.length} 个帖子\n`;
    summary += `❌ 失败: ${failed.length} 个帖子\n\n`;
    
    if (successful.length > 0) {
        summary += `**成功重建的帖子:**\n`;
        successful.forEach(result => {
            summary += `• ${result.fileName}\n`;
            summary += `  📝 消息数: ${result.messagesCount || 0}\n`;
            if (result.threadId) {
                summary += `  🔗 帖子ID: ${result.threadId}\n`;
            }
            summary += `\n`;
        });
    }
    
    if (failed.length > 0) {
        summary += `**失败的文件:**\n`;
        failed.forEach(result => {
            summary += `• ${result.fileName}: ${result.error}\n`;
        });
    }
    
    return summary;
}

module.exports = {
    data,
    execute,
}; 