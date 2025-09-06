const { SlashCommandBuilder } = require('discord.js');
const ExcelReader = require('../services/excelReader');
const MessageProcessor = require('../services/messageProcessor');
const ProgressTracker = require('../services/progressTracker');
const config = require('../config/backupConfig');

// 权限检查
const permissionManager = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('补卡-处理补卡表格文件')
        .setDescription('处理补卡Excel文件，自动发送补卡内容到对应帖子')
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
            option.setName('testmode')
                .setDescription('测试模式：只分析不实际发送消息（默认false）')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('autoarchive')
                .setDescription('自动归档：补卡完成后自动归档帖子（默认使用配置文件设置）')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('allowarchiveintest')
                .setDescription('测试模式下允许归档：在测试模式下也执行归档操作（默认false）')
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
        const testMode = interaction.options.getBoolean('testmode') || false;
        const autoArchive = interaction.options.getBoolean('autoarchive'); // null表示使用配置文件设置
        const allowArchiveInTest = interaction.options.getBoolean('allowarchiveintest') || false;
        const customExcelFile = interaction.options.getString('excelfile');

        console.log(`开始处理补卡命令 - 开始行: ${startRow}, 数量: ${count || '全部'}, 测试模式: ${testMode}, 测试模式归档: ${allowArchiveInTest}`);

        // 初始回复
        await interaction.reply({
            content: `🔄 **开始处理补卡项目**\n\n` +
                    `📋 **参数设置**\n` +
                    `• 开始行: ${startRow}\n` +
                    `• 处理数量: ${count || '全部'}\n` +
                    `• 测试模式: ${testMode ? '是' : '否'}\n` +
                    `• 自动归档: ${autoArchive === null ? '使用配置' : autoArchive ? '是' : '否'}\n` +
                    `• 测试模式归档: ${allowArchiveInTest ? '是' : '否'}\n` +
                    `• Excel文件: ${customExcelFile || '默认配置文件'}\n\n` +
                    `⏳ 正在初始化...`,
            ephemeral: false
        });

        let excelReader = null;
        let messageProcessor = null;
        let progressTracker = null;

        try {
            // 1. 初始化Excel读取器
            await interaction.editReply({
                content: `🔄 **初始化中...**\n\n📖 正在读取Excel文件...`
            });

            excelReader = new ExcelReader(customExcelFile);
            const backupItems = await excelReader.loadExcelData();

            if (backupItems.length === 0) {
                await interaction.editReply({
                    content: '❌ **处理失败**\n\nExcel文件中没有找到有效的补卡数据！'
                });
                return;
            }

            // 2. 计算实际处理范围
            const actualStartIndex = Math.max(0, startRow - 1); // 转换为0基索引
            const actualEndIndex = count ? 
                Math.min(backupItems.length, actualStartIndex + count) : 
                backupItems.length;
            
            const itemsToProcess = backupItems.slice(actualStartIndex, actualEndIndex);

            if (itemsToProcess.length === 0) {
                await interaction.editReply({
                    content: '❌ **处理失败**\n\n指定的行范围内没有有效数据！'
                });
                return;
            }

            // 3. 初始化消息处理器
            await interaction.editReply({
                content: `🔄 **初始化中...**\n\n⚙️ 正在初始化消息处理器...\n\n` +
                        `📊 **待处理数据**\n` +
                        `• 总数据行: ${backupItems.length}\n` +
                        `• 处理范围: ${startRow} - ${actualStartIndex + itemsToProcess.length}\n` +
                        `• 实际处理: ${itemsToProcess.length} 项`
            });

            messageProcessor = new MessageProcessor(interaction.client);
            await messageProcessor.initialize();

            // 4. 初始化进度跟踪器
            progressTracker = new ProgressTracker(interaction);
            await progressTracker.initialize(itemsToProcess.length);

            // 5. 显示预处理信息
            if (testMode) {
                await interaction.editReply({
                    content: `🧪 **测试模式启用**\n\n` +
                            `将分析 ${itemsToProcess.length} 个补卡项目但不实际发送消息\n\n` +
                            `📊 **数据概览**\n` +
                            `• Excel总行数: ${backupItems.length}\n` +
                            `• 待处理: ${itemsToProcess.length} 项\n` +
                            `• 开始位置: 第 ${startRow} 行\n\n` +
                            `⏳ 开始分析...`
                });
            }

            // 6. 处理每个补卡项目
            let processedCount = 0;
            let successCount = 0;
            let failedCount = 0;
            let skippedCount = 0;

            for (let i = 0; i < itemsToProcess.length; i++) {
                const backupItem = itemsToProcess[i];
                
                try {
                    console.log(`\n=== 处理项目 ${i + 1}/${itemsToProcess.length}: ${backupItem.threadId} ===`);
                    
                    const result = await messageProcessor.processBackupItem(backupItem, testMode, autoArchive, allowArchiveInTest);
                    
                    if (result.success) {
                        if (result.skipped) {
                            skippedCount++;
                        } else {
                            successCount++;
                        }
                    } else {
                        failedCount++;
                        console.error(`处理失败: ${result.error}`);
                    }

                    processedCount++;

                    // 更新进度
                    await progressTracker.updateProgress(1, {
                        success: result.success,
                        skipped: result.skipped,
                        archived: result.archived,
                        error: result.error,
                        stats: messageProcessor.getStats()
                    });

                    // 批处理延迟（避免频率限制）
                    if ((i + 1) % config.discord.batchSize === 0 && !testMode) {
                        console.log(`批处理暂停 - 已处理 ${i + 1}/${itemsToProcess.length}`);
                        await delay(2000); // 批处理间隔2秒
                    }

                } catch (error) {
                    console.error(`处理项目时发生错误:`, error);
                    failedCount++;
                    
                    await progressTracker.updateProgress(1, {
                        success: false,
                        error: error.message
                    });
                }
            }

            // 7. 完成处理，显示最终报告
            const finalStats = messageProcessor.getStats();
            finalStats.total = processedCount;
            finalStats.processed = successCount;
            finalStats.failed = failedCount;
            finalStats.skipped = skippedCount;

            await progressTracker.completeProcessing(finalStats);

            // 8. 生成详细报告
            const report = messageProcessor.generateReport();
            console.log('\n=== 补卡处理完成报告 ===');
            console.log('总体统计:', report.summary);
            console.log('类型统计:', report.details);

            // 9. 如果是测试模式，提供额外信息
            if (testMode) {
                const testResults = analyzeTestResults(itemsToProcess, finalStats);
                await interaction.followUp({
                    content: `🧪 **测试分析完成**\n\n` +
                            `📊 **内容分析结果**\n` +
                            `• 文件类型: ${testResults.fileCount} 个\n` +
                            `• 文字描述: ${testResults.textCount} 个\n` +
                            `• Discord链接: ${testResults.linkCount} 个\n` +
                            `• 空内容: ${testResults.emptyCount} 个\n` +
                            `• 未知类型: ${testResults.unknownCount} 个\n\n` +
                            `💡 使用相同参数但关闭测试模式即可开始实际处理`,
                    ephemeral: true
                });
            }

        } catch (error) {
            console.error('补卡处理过程中发生严重错误:', error);
            
            const errorMessage = `❌ **处理失败**\n\n` +
                               `**错误**: ${error.message}\n\n` +
                               `请检查:\n` +
                               `• Excel文件是否存在且格式正确\n` +
                               `• 机器人是否有足够的权限\n` +
                               `• 指定的帖子ID是否有效`;

            try {
                if (progressTracker && progressTracker.isValid()) {
                    await progressTracker.updateMessage({ content: errorMessage });
                } else {
                    await interaction.editReply({ content: errorMessage });
                }
            } catch (updateError) {
                console.error('更新错误消息失败:', updateError);
            }
        }
    }
};

/**
 * 分析测试结果
 */
function analyzeTestResults(items, stats) {
    let fileCount = 0;
    let textCount = 0;
    let linkCount = 0;
    let emptyCount = 0;
    let unknownCount = 0;

    for (const item of items) {
        for (const content of item.cardContents) {
            const trimmed = content.content.trim();
            if (!trimmed) {
                emptyCount++;
            } else if (trimmed.includes('discord.com/channels/')) {
                linkCount++;
            } else if (trimmed.includes('.png') || trimmed.includes('.jpg') || 
                      trimmed.includes('.jpeg') || trimmed.includes('.gif') || 
                      trimmed.includes('.json')) {
                fileCount++;
            } else if (trimmed.includes('作者自补') || trimmed.includes('网盘') || 
                      trimmed.includes('无需匹配')) {
                textCount++;
            } else {
                unknownCount++;
            }
        }
    }

    return { fileCount, textCount, linkCount, emptyCount, unknownCount };
}

/**
 * 延迟函数
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
} 