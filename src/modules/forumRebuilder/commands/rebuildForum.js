const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const ExcelReader = require('../services/excelReader');
const ExcelWriter = require('../services/excelWriter');
const PostRebuilder = require('../services/postRebuilder');
const TagManager = require('../services/tagManager');
const FileManager = require('../utils/fileManager');
const { RebuildResult } = require('../models/forumData');
const config = require('../config/config');
const path = require('path');

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

async function execute(interaction) {
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
            // 1. 读取Excel数据
            await interaction.editReply('📁 正在读取Excel文件...');
            
            const excelReader = new ExcelReader();
            const allPosts = await excelReader.readPosts(absoluteExcelPath);
            
            if (allPosts.length === 0) {
                return interaction.editReply('❌ Excel文件中没有找到有效的帖子数据！');
            }
            
            // 从指定位置开始处理
            const posts = allPosts.slice(startPosition - 1);
            
            if (posts.length === 0) {
                return interaction.editReply(`❌ 从第${startPosition}个位置开始没有更多帖子！`);
            }
            
            // 2. 初始化服务
            const postRebuilder = new PostRebuilder(interaction.client);
            const tagManager = new TagManager();
            const rebuildResult = new RebuildResult();
            rebuildResult.totalPosts = posts.length;
            
            // 3. 创建标签
            await interaction.editReply(`📊 从第${startPosition}个开始，检测到 ${posts.length} 个帖子，正在创建标签...`);
            
            const allTags = await tagManager.getAllTagsFromPosts(posts);
            if (allTags.length > 0) {
                const tagResult = await tagManager.createTagsInForum(targetForum, allTags);
                await interaction.editReply(
                    `🏷️ 标签处理完成！创建了 ${tagResult.createdTags.length} 个新标签\n` +
                    `⏳ 开始重建帖子... (使用优化的速度设置)`
                );
            }
            
            // 4. 初始化Excel写入器
            const excelWriter = new ExcelWriter(absoluteExcelPath);
            await excelWriter.initialize();
            
            // 5. 使用新的优化速度设置
            const batchSize = 5; // 批次大小：5个帖子
            const delayBetweenPosts = 200; // 帖子间延迟：200毫秒
            const delayBetweenBatches = 1000; // 批次间延迟：1秒
            
            let lastProgressUpdate = Date.now();
            const progressUpdateInterval = 5000; // 每5秒更新一次进度
            
            for (let i = 0; i < posts.length; i += batchSize) {
                const batch = posts.slice(i, i + batchSize);
                const actualIndex = startPosition - 1 + i; // 计算在原数组中的实际位置
                
                console.log(`🔄 处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(posts.length / batchSize)}, 帖子 ${i + 1}-${Math.min(i + batchSize, posts.length)}`);
                
                // 逐个处理帖子（避免并发）
                for (let j = 0; j < batch.length; j++) {
                    const post = batch[j];
                    const postIndex = actualIndex + j;
                    
                    try {
                        console.log(`📝 处理帖子 ${i + j + 1}/${posts.length}: ${post.title}`);
                        
                        const result = await postRebuilder.rebuildPost(post, targetForum);
                        
                        if (result.success) {
                            rebuildResult.addSuccess();
                        } else {
                            rebuildResult.addFailure(post, result.error);
                        }
                        
                        // 更新Excel
                        excelWriter.updatePostResult(postIndex, post);
                        
                        // 帖子间延迟（200毫秒）
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
                        
                        // 遇到错误时的延迟（与正常延迟相同）
                        await delay(delayBetweenPosts);
                    }
                }
                
                // 更新进度（每5秒更新一次）
                const now = Date.now();
                if (now - lastProgressUpdate > progressUpdateInterval) {
                    const completedCount = Math.min(i + batchSize, posts.length);
                    const totalCompleted = startPosition - 1 + completedCount;
                    const progressPercent = Math.round((completedCount / posts.length) * 100);
                    const progressBar = generateProgressBar(progressPercent);
                    
                    // 计算速度
                    const timeElapsed = (now - rebuildResult.startTime) / 1000; // 秒
                    const postsPerSecond = rebuildResult.successCount / timeElapsed;
                    const estimatedTimeLeft = (posts.length - completedCount) / postsPerSecond;
                    
                    await interaction.editReply(
                        `🔄 重建进度：${progressBar} ${progressPercent}% (${completedCount}/${posts.length})\n` +
                        `📍 总进度：第${startPosition}到第${totalCompleted}个帖子\n` +
                        `✅ 成功：${rebuildResult.successCount} ❌ 失败：${rebuildResult.failedCount}\n` +
                        `⚡ 速度：${postsPerSecond.toFixed(1)} 帖子/秒 | 预计剩余：${Math.round(estimatedTimeLeft)}秒`
                    );
                    
                    lastProgressUpdate = now;
                }
                
                // 批次间延迟（1秒）
                if (i + batchSize < posts.length) {
                    console.log(`⏱️ 批次完成，等待 ${delayBetweenBatches / 1000} 秒后继续...`);
                    await delay(delayBetweenBatches);
                }
            }
            
            // 6. 保存结果Excel文件
            await interaction.editReply('💾 正在保存结果文件...');
            
            const resultsDir = FileManager.getResultsDirectory();
            await FileManager.ensureDirectory(resultsDir);
            
            const outputFileName = excelWriter.generateOutputFileName(
                absoluteExcelPath, 
                targetForum.id
            );
            const outputPath = path.join(resultsDir, outputFileName);
            
            await excelWriter.saveToFile(outputPath);
            rebuildResult.complete(outputPath);
            
            // 7. 清理资源
            await postRebuilder.cleanup(targetForum);
            
            // 8. 发送完成报告
            const completionMessage = generateCompletionMessage(rebuildResult, outputFileName, startPosition, allPosts.length);
            await interaction.editReply(completionMessage);
            
        } catch (error) {
            console.error('重建论坛时出错:', error);
            
            // 检查是否是频率限制错误
            if (error.code === 429 || error.message.includes('rate limit')) {
                await interaction.editReply(
                    `⚠️ 遇到Discord API频率限制，请等待几分钟后使用以下命令继续：\n` +
                    `\`/重建论坛 目标论坛:${targetForum} 开始位置:${startPosition + rebuildResult.successCount}\`\n\n` +
                    `当前已成功重建：${rebuildResult.successCount} 个帖子`
                );
            } else {
                await interaction.editReply(`❌ 重建过程中出现错误: ${error.message}`);
            }
        }
        
    } catch (error) {
        console.error('执行重建论坛命令时出错:', error);
        
        if (interaction.deferred) {
            await interaction.editReply('❌ 命令执行失败，请检查日志。');
        } else {
            await interaction.reply({
                content: '❌ 命令执行失败，请检查日志。',
                flags: MessageFlags.Ephemeral
            });
        }
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