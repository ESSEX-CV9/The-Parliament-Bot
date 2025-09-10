const { SlashCommandBuilder } = require('discord.js');
const ExcelReader = require('../services/excelReader');
const ContentAnalyzer = require('../utils/contentAnalyzer');
const FileLocator = require('../services/fileLocator');
const config = require('../config/backupConfig');

// 权限检查
const permissionManager = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('补卡-测试补卡模块')
        .setDescription('测试补卡模块的基础功能')
        .addIntegerOption(option =>
            option.setName('rows')
                .setDescription('测试的行数（默认5行）')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)),

    async execute(interaction) {
        // 权限检查
        if (!permissionManager.checkAdminPermission(interaction.member)) {
            await interaction.reply({
                content: permissionManager.getPermissionDeniedMessage(),
                ephemeral: true
            });
            return;
        }

        const testRows = interaction.options.getInteger('rows') || 5;

        await interaction.reply({
            content: `🧪 **开始测试补卡模块**\n\n⏳ 正在初始化各个组件...`,
            ephemeral: false
        });

        try {
            // 1. 测试Excel读取器
            await interaction.editReply({
                content: `🧪 **测试进行中**\n\n📖 测试Excel读取器...`
            });

            const excelReader = new ExcelReader();
            const backupItems = await excelReader.loadExcelData();

            if (backupItems.length === 0) {
                await interaction.editReply({
                    content: `❌ **测试失败**\n\nExcel文件中没有找到数据！`
                });
                return;
            }

            // 2. 测试内容分析器
            await interaction.editReply({
                content: `🧪 **测试进行中**\n\n🔍 测试内容分析器...`
            });

            const contentAnalyzer = new ContentAnalyzer();
            const testItem = backupItems[0];
            let analysisResults = [];

            if (testItem.cardContents.length > 0) {
                const testContent = testItem.cardContents[0];
                const analysis = contentAnalyzer.analyzeContent(testContent.content);
                analysisResults.push({
                    content: testContent.content,
                    type: analysis.type,
                    description: analysis.description
                });
            }

            // 3. 测试文件定位器
            await interaction.editReply({
                content: `🧪 **测试进行中**\n\n📁 测试文件定位器...`
            });

            const fileLocator = new FileLocator();
            await fileLocator.initializeCache();
            const cacheStats = fileLocator.getCacheStats();

            // 4. 生成测试结果
            const testResults = backupItems.slice(0, testRows);
            let contentTypeStats = {
                files: 0,
                textDescriptions: 0,
                discordLinks: 0,
                empty: 0,
                unknown: 0
            };

            for (const item of testResults) {
                for (const content of item.cardContents) {
                    const analysis = contentAnalyzer.analyzeContent(content.content);
                    switch (analysis.type) {
                        case 'file':
                            contentTypeStats.files++;
                            break;
                        case 'text_description':
                            contentTypeStats.textDescriptions++;
                            break;
                        case 'discord_link':
                            contentTypeStats.discordLinks++;
                            break;
                        case 'empty':
                            contentTypeStats.empty++;
                            break;
                        default:
                            contentTypeStats.unknown++;
                    }
                }
            }

            // 5. 生成详细报告
            const resultMessage = `✅ **补卡模块测试完成**\n\n` +
                                `📊 **Excel数据统计**\n` +
                                `• 总数据行: ${backupItems.length}\n` +
                                `• 测试行数: ${testResults.length}\n` +
                                `• 有补卡内容的行: ${testResults.filter(item => item.cardContents.length > 0).length}\n\n` +
                                `🔍 **内容类型分析 (前${testRows}行)**\n` +
                                `• 文件类型: ${contentTypeStats.files} 个\n` +
                                `• 文字描述: ${contentTypeStats.textDescriptions} 个\n` +
                                `• Discord链接: ${contentTypeStats.discordLinks} 个\n` +
                                `• 空内容: ${contentTypeStats.empty} 个\n` +
                                `• 未知类型: ${contentTypeStats.unknown} 个\n\n` +
                                `📁 **文件缓存统计**\n` +
                                `• 总文件数: ${cacheStats.totalFiles}\n` +
                                `• 缓存区域: ${Object.keys(cacheStats.locations).join(', ')}\n\n` +
                                `📋 **配置状态**\n` +
                                `• Excel文件: 已加载\n` +
                                `• 文件目录: 已缓存\n` +
                                `• 系统状态: 就绪\n\n` +
                                `🎯 **测试结论**: 所有核心组件正常工作\n` +
                                `💡 可以使用 \`/processbackupcards\` 命令开始实际处理`;

            await interaction.editReply({
                content: resultMessage
            });

            // 6. 如果有分析结果，发送样例
            if (analysisResults.length > 0) {
                const sampleAnalysis = analysisResults[0];
                await interaction.followUp({
                    content: `📝 **内容分析样例**\n\n` +
                            `**原始内容**: \`${sampleAnalysis.content}\`\n` +
                            `**识别类型**: ${sampleAnalysis.type}\n` +
                            `**描述**: ${sampleAnalysis.description}`,
                    ephemeral: true
                });
            }

        } catch (error) {
            console.error('补卡模块测试失败:', error);
            
            await interaction.editReply({
                content: `❌ **测试失败**\n\n` +
                        `**错误**: ${error.message}\n\n` +
                        `请检查:\n` +
                        `• Excel文件是否存在\n` +
                        `• 图片目录是否可访问\n` +
                        `• 配置文件是否正确\n` +
                        `• 文件权限是否充足`
            });
        }
    }
}; 