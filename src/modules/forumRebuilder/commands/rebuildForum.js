const { SlashCommandBuilder, MessageFlags, ChannelType, AttachmentBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const ExcelReader = require('../services/excelReader');
const ExcelWriter = require('../services/excelWriter');
const PostRebuilder = require('../services/postRebuilder');
const TagManager = require('../services/tagManager');
const FileManager = require('../utils/fileManager');
const { RebuildResult } = require('../models/forumData');
const config = require('../config/config');
const path = require('path');
const fs = require('fs');

const data = new SlashCommandBuilder()
    .setName('重建论坛')
    .setDescription('从Excel文件重建论坛帖子（管理员专用）')
    .addChannelOption(option =>
        option.setName('目标论坛')
            .setDescription('要重建到的论坛频道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildForum)
    )
    .addStringOption(option =>
        option.setName('excel文件路径')
            .setDescription('Excel备份文件的路径（可选，默认使用配置的路径）')
            .setRequired(false)
    )
    .addIntegerOption(option =>
        option.setName('开始位置')
            .setDescription('从第几个帖子开始重建（用于断点续传，默认从第1个开始）')
            .setRequired(false)
            .setMinValue(1)
    );

// 消息更新管理器
class MessageUpdateManager {
    constructor(interaction) {
        this.originalInteraction = interaction;
        this.currentMessage = null;
        this.isUsingNewMessage = false;
        this.channel = interaction.channel;
        this.interactionValid = true;
    }
    
    async updateMessage(content) {
        // 如果还在使用原始交互
        if (!this.isUsingNewMessage && this.interactionValid) {
            try {
                await this.originalInteraction.editReply(content);
                return true;
            } catch (error) {
                if (error.code === 50027) { // Invalid Webhook Token
                    console.log('⚠️ Discord交互token已失效，尝试发送新消息继续更新...');
                    this.interactionValid = false;
                    
                    // 尝试发送新消息
                    if (await this.createNewProgressMessage(content)) {
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
                await this.currentMessage.edit(content);
                return true;
            } catch (error) {
                console.error('更新新消息失败:', error);
                return false;
            }
        }
        
        return false;
    }
    
    async createNewProgressMessage(content) {
        try {
            console.log('🔄 创建新的进度更新消息...');
            
            const newContent = `📢 **论坛重建进度更新** (原交互已失效，使用新消息继续)\n\n${content}`;
            
            this.currentMessage = await this.channel.send(newContent);
            this.isUsingNewMessage = true;
            
            console.log('✅ 成功创建新的进度更新消息');
            return true;
            
        } catch (error) {
            console.error('创建新进度消息失败:', error);
            return false;
        }
    }
    
    async sendFile(options) {
        // 如果原始交互仍然有效，使用 followUp
        if (this.interactionValid) {
            try {
                await this.originalInteraction.followUp(options);
                return true;
            } catch (error) {
                if (error.code === 50027) {
                    console.log('⚠️ 交互失效，使用频道发送文件...');
                    this.interactionValid = false;
                } else {
                    console.error('使用交互发送文件失败:', error);
                    return false;
                }
            }
        }
        
        // 使用频道直接发送
        try {
            await this.channel.send(options);
            return true;
        } catch (error) {
            console.error('使用频道发送文件失败:', error);
            return false;
        }
    }
    
    isValid() {
        return this.interactionValid || this.isUsingNewMessage;
    }
}

async function execute(interaction) {
    const messageManager = new MessageUpdateManager(interaction);
    
    try {
        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        const targetForum = interaction.options.getChannel('目标论坛');
        const customExcelPath = interaction.options.getString('excel文件路径');
        const startPosition = interaction.options.getInteger('开始位置') || 1;
        
        // 验证目标论坛
        if (targetForum.type !== ChannelType.GuildForum) {
            return interaction.reply({
                content: '❌ 指定的频道不是论坛频道！',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 准备Excel文件路径
        const excelPath = customExcelPath || config.excel.inputPath;
        const absoluteExcelPath = path.resolve(excelPath);
        
        // 验证Excel文件
        try {
            await FileManager.validateExcelFile(absoluteExcelPath);
        } catch (error) {
            return interaction.reply({
                content: `❌ Excel文件验证失败: ${error.message}`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 延迟回复，开始处理
        await interaction.deferReply({ ephemeral: true });
        
        try {
            // 1. 初始化Excel写入器
            await messageManager.updateMessage('📁 正在初始化Excel进度文件...');
            
            const excelWriter = new ExcelWriter(absoluteExcelPath, targetForum.id);
            await excelWriter.initialize();
            
            // 2. 读取Excel数据
            await messageManager.updateMessage('📖 正在读取Excel文件...');
            
            const excelReader = new ExcelReader();
            const allPosts = await excelReader.readPosts(absoluteExcelPath);
            
            if (allPosts.length === 0) {
                await messageManager.updateMessage('❌ Excel文件中没有找到有效的帖子数据！');
                return;
            }
            
            // 3. 检查断点续传情况
            let actualStartPosition = startPosition;
            if (excelWriter.isResuming) {
                // 查找实际的开始位置
                for (let i = 0; i < allPosts.length; i++) {
                    if (!excelWriter.isRowProcessed(i)) {
                        actualStartPosition = i + 1;
                        break;
                    }
                }
                
                if (actualStartPosition > allPosts.length) {
                    await messageManager.updateMessage('✅ 所有帖子都已处理完成！');
                    return;
                }
                
                await messageManager.updateMessage(
                    `🔄 检测到进度文件，从第${actualStartPosition}个帖子继续处理\n` +
                    `📄 进度文件：${excelWriter.getOutputFileName()}`
                );
            }
            
            const posts = allPosts.slice(actualStartPosition - 1);
            
            if (posts.length === 0) {
                await messageManager.updateMessage(`❌ 从第${actualStartPosition}个位置开始没有更多帖子！`);
                return;
            }
            
            // 4. 初始化服务
            const postRebuilder = new PostRebuilder(interaction.client);
            const tagManager = new TagManager();
            const rebuildResult = new RebuildResult();
            rebuildResult.totalPosts = posts.length;
            
            // 5. 创建标签
            await messageManager.updateMessage(`📊 从第${actualStartPosition}个开始，检测到 ${posts.length} 个帖子，正在创建标签...`);
            
            const allTags = await tagManager.getAllTagsFromPosts(posts);
            if (allTags.length > 0) {
                const tagResult = await tagManager.createTagsInForum(targetForum, allTags);
                await messageManager.updateMessage(
                    `🏷️ 标签处理完成！创建了 ${tagResult.createdTags.length} 个新标签\n` +
                    `⏳ 开始重建帖子... (使用优化的速度设置)`
                );
            }
            
            // 6. 使用优化速度设置
            const batchSize = 5;
            const delayBetweenPosts = 200;
            const delayBetweenBatches = 1000;
            
            let lastProgressUpdate = Date.now();
            const progressUpdateInterval = 10000; // 10秒更新一次
            
            console.log(`🚀 开始重建任务，共${posts.length}个帖子`);
            
            for (let i = 0; i < posts.length; i += batchSize) {
                const batch = posts.slice(i, i + batchSize);
                const actualIndex = actualStartPosition - 1 + i;
                
                console.log(`🔄 处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(posts.length / batchSize)}, 帖子 ${i + 1}-${Math.min(i + batchSize, posts.length)}`);
                
                let batchHasUpdates = false;
                
                // 逐个处理帖子
                for (let j = 0; j < batch.length; j++) {
                    const post = batch[j];
                    const postIndex = actualIndex + j;
                    
                    // 检查是否已经处理过
                    if (excelWriter.isRowProcessed(postIndex)) {
                        console.log(`⏭️ 跳过已处理的帖子 ${i + j + 1}: ${post.title}`);
                        rebuildResult.addSuccess();
                        continue;
                    }
                    
                    try {
                        console.log(`📝 处理帖子 ${i + j + 1}/${posts.length}: ${post.title}`);
                        
                        const result = await postRebuilder.rebuildPost(post, targetForum);
                        
                        if (result.success) {
                            rebuildResult.addSuccess();
                            post.setRebuildResult({
                                newForumId: targetForum.id,
                                newPostId: result.postId,
                                status: 'success',
                                error: null
                            });
                        } else {
                            rebuildResult.addFailure(post, result.error);
                            post.setRebuildResult({
                                newForumId: targetForum.id,
                                newPostId: null,
                                status: 'failed',
                                error: result.error
                            });
                        }
                        
                        // 更新Excel
                        excelWriter.updatePostResult(postIndex, post);
                        batchHasUpdates = true;
                        
                        if (j < batch.length - 1) {
                            await delay(delayBetweenPosts);
                        }
                        
                    } catch (error) {
                        console.error('处理帖子时出错:', error);
                        rebuildResult.addFailure(post, error.message);
                        post.setRebuildResult({
                            newForumId: targetForum.id,
                            newPostId: null,
                            status: 'failed',
                            error: error.message
                        });
                        excelWriter.updatePostResult(postIndex, post);
                        batchHasUpdates = true;
                        await delay(delayBetweenPosts);
                    }
                }
                
                // 每批次完成后保存进度
                if (batchHasUpdates) {
                    await excelWriter.saveProgress();
                }
                
                // 更新进度
                const now = Date.now();
                if (now - lastProgressUpdate > progressUpdateInterval) {
                    const completedCount = Math.min(i + batchSize, posts.length);
                    const totalCompleted = actualStartPosition - 1 + completedCount;
                    const progressPercent = Math.round((completedCount / posts.length) * 100);
                    const progressBar = generateProgressBar(progressPercent);
                    
                    const timeElapsed = (now - rebuildResult.startTime) / 1000;
                    const postsPerSecond = rebuildResult.successCount / timeElapsed;
                    const estimatedTimeLeft = (posts.length - completedCount) / postsPerSecond;
                    
                    await messageManager.updateMessage(
                        `🔄 重建进度：${progressBar} ${progressPercent}% (${completedCount}/${posts.length})\n` +
                        `📍 总进度：第${actualStartPosition}到第${totalCompleted}个帖子\n` +
                        `✅ 成功：${rebuildResult.successCount} ❌ 失败：${rebuildResult.failedCount}\n` +
                        `⚡ 速度：${postsPerSecond.toFixed(1)} 帖子/秒 | 预计剩余：${Math.round(estimatedTimeLeft)}秒\n` +
                        `📄 进度文件：${excelWriter.getOutputFileName()}`
                    );
                    
                    lastProgressUpdate = now;
                }
                
                // 批次间延迟
                if (i + batchSize < posts.length) {
                    console.log(`⏱️ 批次完成，等待 ${delayBetweenBatches / 1000} 秒后继续...`);
                    await delay(delayBetweenBatches);
                }
            }
            
            // 7. 最终保存
            console.log('💾 保存最终结果...');
            await excelWriter.saveProgress();
            
            const outputPath = excelWriter.getOutputPath();
            const outputFileName = excelWriter.getOutputFileName();
            rebuildResult.complete(outputPath);
            
            // 8. 清理资源
            await postRebuilder.cleanup(targetForum);
            
            // 9. 发送完成报告
            const completionMessage = generateCompletionMessage(rebuildResult, outputFileName, actualStartPosition, allPosts.length);
            await messageManager.updateMessage(completionMessage);
            
            // 10. 发送Excel文件
            await sendExcelFile(messageManager, outputPath, outputFileName, rebuildResult);
            
        } catch (error) {
            console.error('重建论坛时出错:', error);
            
            if (error.code === 429 || error.message.includes('rate limit')) {
                const message = `⚠️ 遇到Discord API频率限制，请等待几分钟后使用以下命令继续：\n` +
                    `\`/重建论坛 目标论坛:${targetForum}\`\n\n` +
                    `系统会自动从上次中断的位置继续处理。`;
                
                await messageManager.updateMessage(message);
            } else {
                const errorMessage = `❌ 重建过程中出现错误: ${error.message}`;
                await messageManager.updateMessage(errorMessage);
            }
        }
        
    } catch (error) {
        console.error('执行重建论坛命令时出错:', error);
        
        try {
            if (interaction.deferred) {
                await messageManager.updateMessage('❌ 命令执行失败，请检查日志。');
            } else {
                await interaction.reply({
                    content: '❌ 命令执行失败，请检查日志。',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (finalError) {
            console.error('最终错误处理也失败:', finalError);
        }
    }
}

async function sendExcelFile(messageManager, filePath, fileName, rebuildResult) {
    try {
        console.log('📤 准备发送Excel结果文件...');
        
        if (!fs.existsSync(filePath)) {
            console.error('Excel文件不存在:', filePath);
            await messageManager.sendFile({
                content: '⚠️ Excel结果文件不存在，无法发送文件。',
                ephemeral: true
            });
            return;
        }
        
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > 25) {
            console.log(`⚠️ 文件过大 (${fileSizeMB.toFixed(2)}MB)，无法发送`);
            await messageManager.sendFile({
                content: `⚠️ Excel文件过大 (${fileSizeMB.toFixed(2)}MB)，超过Discord 25MB限制。\n` +
                        `文件已保存在服务器: \`${fileName}\``,
                ephemeral: false
            });
            return;
        }
        
        const attachment = new AttachmentBuilder(filePath, { name: fileName });
        
        const fileMessage = `📊 **重建结果Excel文件**\n\n` +
            `📄 **文件名称：** \`${fileName}\`\n` +
            `📏 **文件大小：** ${fileSizeMB.toFixed(2)}MB\n` +
            `📈 **处理结果：** ${rebuildResult.successCount} 成功 / ${rebuildResult.failedCount} 失败\n` +
            `⏰ **生成时间：** ${new Date().toLocaleString('zh-CN')}\n\n` +
            `💡 **说明：** 该文件包含了所有帖子的重建结果，包括新的论坛ID和帖子ID。`;
        
        const success = await messageManager.sendFile({
            content: fileMessage,
            files: [attachment],
            ephemeral: false
        });
        
        if (success) {
            console.log(`✅ Excel文件发送成功: ${fileName} (${fileSizeMB.toFixed(2)}MB)`);
        } else {
            console.log(`📄 Excel文件已保存但无法发送: ${filePath}`);
        }
        
    } catch (error) {
        console.error('发送Excel文件失败:', error);
        
        await messageManager.sendFile({
            content: `❌ 发送Excel文件失败: ${error.message}\n` +
                    `文件已保存在服务器，请联系管理员获取: \`${fileName}\``,
            ephemeral: false
        });
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateProgressBar(percent) {
    const totalBars = 20;
    const filledBars = Math.round((percent / 100) * totalBars);
    const emptyBars = totalBars - filledBars;
    
    return '[' + '█'.repeat(filledBars) + '░'.repeat(emptyBars) + ']';
}

function generateCompletionMessage(result, outputFileName, startPosition, totalPosts) {
    const lines = [];
    
    lines.push('🎉 **论坛重建完成！**\n');
    
    lines.push('📊 **统计信息：**');
    lines.push(`• 处理范围：第${startPosition}到第${startPosition + result.totalPosts - 1}个帖子 (共${totalPosts}个)`);
    lines.push(`• 本次处理：${result.totalPosts} 个帖子`);
    lines.push(`• ✅ 成功：${result.successCount}`);
    lines.push(`• ❌ 失败：${result.failedCount}`);
    lines.push(`• 📈 成功率：${result.getSuccessRate()}%`);
    lines.push(`• ⏱️ 用时：${result.getDuration()}秒`);
    lines.push(`• ⚡ 平均速度：${(result.successCount / result.getDuration()).toFixed(1)} 帖子/秒`);
    
    if (startPosition + result.totalPosts - 1 < totalPosts) {
        const remaining = totalPosts - (startPosition + result.totalPosts - 1);
        lines.push(`\n⏭️ **剩余 ${remaining} 个帖子未处理**`);
        lines.push(`继续处理命令：\`/重建论坛 开始位置:${startPosition + result.totalPosts}\``);
    }
    
    lines.push(`\n📄 **结果文件：** \`${outputFileName}\``);
    
    if (result.failedPosts.length > 0) {
        lines.push(`\n❌ **失败的帖子：**`);
        const displayCount = Math.min(result.failedPosts.length, 3);
        
        for (let i = 0; i < displayCount; i++) {
            const failed = result.failedPosts[i];
            lines.push(`• ${failed.title} - ${failed.error}`);
        }
        
        if (result.failedPosts.length > 3) {
            lines.push(`• ... 还有 ${result.failedPosts.length - 3} 个失败项目`);
        }
    }
    
    return lines.join('\n');
}

module.exports = {
    data,
    execute
}; 