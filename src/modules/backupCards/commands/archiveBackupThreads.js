const { SlashCommandBuilder } = require('discord.js');
const ExcelReader = require('../services/excelReader');
const config = require('../config/backupConfig');

// 权限检查
const permissionManager = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('补卡-批量归档补卡线程')
        .setDescription('批量归档补卡线程')
        .addIntegerOption(option =>
            option.setName('start')
                .setDescription('开始处理的行号（默认从第1行开始）')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('处理的行数（默认处理全部）')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100))
        .addBooleanOption(option =>
            option.setName('dryrun')
                .setDescription('试运行：只检查线程状态不实际归档（默认false）')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('excelfile')
                .setDescription('指定Excel文件路径（可选，默认使用配置中的文件）')
                .setRequired(false)),

    async execute(interaction) {
        // 权限检查
        if (!permissionManager.checkAdminPermission(interaction.member)) {
            await interaction.reply({
                content: permissionManager.getPermissionDeniedMessage(),
                ephemeral: true
            });
            return;
        }

        // 获取参数
        const startRow = interaction.options.getInteger('start') || 1;
        const count = interaction.options.getInteger('count');
        const dryRun = interaction.options.getBoolean('dryrun') || false;
        const customExcelFile = interaction.options.getString('excelfile');

        console.log(`开始归档操作 - 开始行: ${startRow}, 数量: ${count || '全部'}, 试运行: ${dryRun}`);

        // 初始回复
        await interaction.reply({
            content: `📁 **批量归档补卡线程**\n\n` +
                    `📋 **参数设置**\n` +
                    `• 开始行: ${startRow}\n` +
                    `• 处理数量: ${count || '全部'}\n` +
                    `• 试运行模式: ${dryRun ? '是（不实际归档）' : '否'}\n` +
                    `• Excel文件: ${customExcelFile || '默认配置文件'}\n\n` +
                    `⏳ 正在读取数据...`,
            ephemeral: false
        });

        try {
            // 1. 读取Excel数据
            const excelReader = new ExcelReader(customExcelFile);
            const backupItems = await excelReader.loadExcelData();

            if (backupItems.length === 0) {
                await interaction.editReply({
                    content: '❌ **操作失败**\n\nExcel文件中没有找到有效的补卡数据！'
                });
                return;
            }

            // 2. 计算实际处理范围
            const actualStartIndex = Math.max(0, startRow - 1);
            const actualEndIndex = count ? 
                Math.min(backupItems.length, actualStartIndex + count) : 
                backupItems.length;
            
            const itemsToProcess = backupItems.slice(actualStartIndex, actualEndIndex);

            if (itemsToProcess.length === 0) {
                await interaction.editReply({
                    content: '❌ **操作失败**\n\n指定的行范围内没有有效数据！'
                });
                return;
            }

            // 3. 更新状态
            await interaction.editReply({
                content: `📁 **开始归档操作**\n\n` +
                        `📊 **数据概览**\n` +
                        `• Excel总行数: ${backupItems.length}\n` +
                        `• 待处理: ${itemsToProcess.length} 个线程\n` +
                        `• 开始位置: 第 ${startRow} 行\n` +
                        `• 模式: ${dryRun ? '试运行（检查状态）' : '实际归档'}\n\n` +
                        `⏳ 开始处理...`
            });

            // 4. 执行归档操作
            let totalCount = 0;
            let archivedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            let notThreadCount = 0;
            let alreadyArchivedCount = 0;
            const errors = [];

            for (let i = 0; i < itemsToProcess.length; i++) {
                const backupItem = itemsToProcess[i];
                totalCount++;

                try {
                    console.log(`\n=== 处理线程 ${i + 1}/${itemsToProcess.length}: ${backupItem.threadId} ===`);
                    
                    // 获取目标频道
                    const targetChannel = await interaction.client.channels.fetch(backupItem.threadId);
                    
                    if (!targetChannel) {
                        console.error(`无法找到频道: ${backupItem.threadId}`);
                        failedCount++;
                        errors.push(`${backupItem.threadId}: 频道不存在`);
                        continue;
                    }

                    // 检查是否为线程
                    if (!targetChannel.isThread || !targetChannel.isThread()) {
                        console.log(`频道 ${backupItem.threadId} 不是线程，跳过`);
                        notThreadCount++;
                        continue;
                    }

                    // 检查是否已归档
                    if (targetChannel.archived) {
                        console.log(`线程 ${backupItem.threadId} 已归档，跳过`);
                        alreadyArchivedCount++;
                        continue;
                    }

                    // 检查权限
                    const permissions = targetChannel.permissionsFor(targetChannel.guild.members.me);
                    if (!permissions || !permissions.has(['ManageThreads'])) {
                        console.log(`缺少管理线程权限: ${backupItem.threadId}`);
                        failedCount++;
                        errors.push(`${backupItem.threadId}: 缺少权限`);
                        continue;
                    }

                    if (dryRun) {
                        console.log(`[试运行] 线程 ${backupItem.threadId} 可以归档`);
                        skippedCount++;
                    } else {
                        // 执行归档
                        const archiveConfig = config.discord.autoArchive;
                        const reason = (archiveConfig && archiveConfig.reason) || '批量归档补卡线程';
                        
                        await targetChannel.setArchived(true, reason);
                        console.log(`✅ 线程已归档: ${backupItem.threadId} - ${backupItem.title}`);
                        archivedCount++;

                        // 控制频率
                        await delay(1000);
                    }

                    // 每处理10个更新一次进度
                    if ((i + 1) % 10 === 0) {
                        await interaction.editReply({
                            content: `📁 **归档进度: ${i + 1}/${itemsToProcess.length}**\n\n` +
                                    `📊 **当前统计**\n` +
                                    `• ${dryRun ? '可归档' : '已归档'}: ${dryRun ? skippedCount : archivedCount}\n` +
                                    `• 已归档跳过: ${alreadyArchivedCount}\n` +
                                    `• 非线程跳过: ${notThreadCount}\n` +
                                    `• 失败: ${failedCount}\n\n` +
                                    `⏳ 继续处理中...`
                        });
                    }

                } catch (error) {
                    console.error(`处理线程 ${backupItem.threadId} 时出错:`, error);
                    failedCount++;
                    errors.push(`${backupItem.threadId}: ${error.message}`);
                }
            }

            // 5. 生成最终报告
            const successCount = dryRun ? skippedCount : archivedCount;
            const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

            let finalContent = `${dryRun ? '🧪' : '✅'} **${dryRun ? '试运行' : '归档'}完成**\n\n`;
            
            finalContent += `📊 **最终统计**\n`;
            finalContent += `• 总处理: ${totalCount} 个线程\n`;
            finalContent += `• ${dryRun ? '可归档' : '已归档'}: ${successCount}\n`;
            finalContent += `• 已归档跳过: ${alreadyArchivedCount}\n`;
            finalContent += `• 非线程跳过: ${notThreadCount}\n`;
            finalContent += `• 失败: ${failedCount}\n`;
            finalContent += `• 成功率: ${successRate}%\n\n`;

            if (errors.length > 0) {
                finalContent += `❌ **错误列表**\n`;
                const errorSample = errors.slice(0, 5);
                finalContent += errorSample.map(error => `• ${error}`).join('\n');
                if (errors.length > 5) {
                    finalContent += `\n• ... 还有 ${errors.length - 5} 个错误`;
                }
            }

            await interaction.editReply({
                content: finalContent
            });

            console.log('\n=== 归档操作完成 ===');
            console.log(`总计: ${totalCount}, ${dryRun ? '可归档' : '已归档'}: ${successCount}, 失败: ${failedCount}`);

        } catch (error) {
            console.error('归档操作失败:', error);
            await interaction.editReply({
                content: `❌ **归档操作失败**\n\n错误信息: ${error.message}`
            });
        }
    }
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
} 