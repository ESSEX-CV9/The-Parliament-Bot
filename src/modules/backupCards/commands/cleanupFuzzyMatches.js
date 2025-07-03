const { SlashCommandBuilder } = require('discord.js');
const ExcelReader = require('../services/excelReader');
const config = require('../config/backupConfig');

// 权限检查
const permissionManager = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cleanupfuzzymatches')
        .setDescription('批量清理模糊匹配的补卡消息')
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
                .setDescription('试运行：只查找不实际删除（默认false）')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('只删除指定天数前的消息（默认所有）')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30))
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
        const days = interaction.options.getInteger('days');
        const customExcelFile = interaction.options.getString('excelfile');

        console.log(`开始清理模糊匹配 - 开始行: ${startRow}, 数量: ${count || '全部'}, 试运行: ${dryRun}, 天数限制: ${days || '无'}`);

        // 初始回复
        await interaction.reply({
            content: `🧹 **清理模糊匹配补卡消息**\n\n` +
                    `📋 **参数设置**\n` +
                    `• 开始行: ${startRow}\n` +
                    `• 处理数量: ${count || '全部'}\n` +
                    `• 试运行模式: ${dryRun ? '是（不实际删除）' : '否'}\n` +
                    `• 时间限制: ${days ? `${days}天前` : '无限制'}\n` +
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
                content: `🧹 **开始清理操作**\n\n` +
                        `📊 **数据概览**\n` +
                        `• Excel总行数: ${backupItems.length}\n` +
                        `• 待处理: ${itemsToProcess.length} 个线程\n` +
                        `• 开始位置: 第 ${startRow} 行\n` +
                        `• 模式: ${dryRun ? '试运行（查找但不删除）' : '实际删除'}\n\n` +
                        `⏳ 开始扫描模糊匹配消息...`
            });

            // 4. 执行清理操作
            let totalCount = 0;
            let scannedThreads = 0;
            let foundMessages = 0;
            let deletedMessages = 0;
            let failedDeletions = 0;
            let skippedThreads = 0;
            const errors = [];
            const cutoffDate = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

            for (let i = 0; i < itemsToProcess.length; i++) {
                const backupItem = itemsToProcess[i];
                totalCount++;

                try {
                    console.log(`\n=== 扫描线程 ${i + 1}/${itemsToProcess.length}: ${backupItem.threadId} ===`);
                    
                    // 获取目标频道
                    const targetChannel = await interaction.client.channels.fetch(backupItem.threadId);
                    
                    if (!targetChannel) {
                        console.error(`无法找到频道: ${backupItem.threadId}`);
                        skippedThreads++;
                        errors.push(`${backupItem.threadId}: 频道不存在`);
                        continue;
                    }

                    // 检查是否为线程或频道
                    if (targetChannel.isThread && targetChannel.isThread() && targetChannel.archived) {
                        console.log(`线程 ${backupItem.threadId} 已归档，跳过`);
                        skippedThreads++;
                        continue;
                    }

                    scannedThreads++;

                    // 搜索机器人发送的消息
                    const messages = await this.fetchBotMessages(targetChannel, interaction.client.user.id, cutoffDate);
                    
                    // 筛选模糊匹配消息
                    const fuzzyMessages = messages.filter(message => this.isFuzzyMatchMessage(message));
                    
                    if (fuzzyMessages.length > 0) {
                        console.log(`发现 ${fuzzyMessages.length} 个模糊匹配消息`);
                        foundMessages += fuzzyMessages.length;

                        if (!dryRun) {
                            // 删除消息
                            for (const message of fuzzyMessages) {
                                try {
                                    await message.delete();
                                    deletedMessages++;
                                    console.log(`✅ 删除消息: ${message.id}`);
                                    
                                    // 控制删除频率
                                    await delay(500);
                                    
                                } catch (deleteError) {
                                    console.error(`删除消息失败 ${message.id}:`, deleteError);
                                    failedDeletions++;
                                    errors.push(`${backupItem.threadId}: 删除消息失败 - ${deleteError.message}`);
                                }
                            }
                        }
                    }

                    // 每处理10个更新一次进度
                    if ((i + 1) % 10 === 0) {
                        await interaction.editReply({
                            content: `🧹 **清理进度: ${i + 1}/${itemsToProcess.length}**\n\n` +
                                    `📊 **当前统计**\n` +
                                    `• 已扫描线程: ${scannedThreads}\n` +
                                    `• 跳过线程: ${skippedThreads}\n` +
                                    `• 发现模糊匹配: ${foundMessages}\n` +
                                    `• ${dryRun ? '可删除' : '已删除'}: ${dryRun ? foundMessages : deletedMessages}\n` +
                                    `• 删除失败: ${failedDeletions}\n\n` +
                                    `⏳ 继续处理中...`
                        });
                    }

                } catch (error) {
                    console.error(`处理线程 ${backupItem.threadId} 时出错:`, error);
                    skippedThreads++;
                    errors.push(`${backupItem.threadId}: ${error.message}`);
                }
            }

            // 5. 生成最终报告
            const successRate = foundMessages > 0 ? Math.round((deletedMessages / foundMessages) * 100) : 100;

            let finalContent = `${dryRun ? '🔍' : '✅'} **${dryRun ? '扫描' : '清理'}完成**\n\n`;
            
            finalContent += `📊 **最终统计**\n`;
            finalContent += `• 总处理: ${totalCount} 个线程\n`;
            finalContent += `• 成功扫描: ${scannedThreads}\n`;
            finalContent += `• 跳过线程: ${skippedThreads}\n`;
            finalContent += `• 发现模糊匹配: ${foundMessages} 条消息\n`;
            if (!dryRun) {
                finalContent += `• 成功删除: ${deletedMessages}\n`;
                finalContent += `• 删除失败: ${failedDeletions}\n`;
                finalContent += `• 删除成功率: ${successRate}%\n`;
            }
            finalContent += `\n`;

            if (days) {
                finalContent += `⏰ **时间范围**: ${days}天前至今\n\n`;
            }

            if (errors.length > 0) {
                finalContent += `❌ **错误列表**\n`;
                const errorSample = errors.slice(0, 5);
                finalContent += errorSample.map(error => `• ${error}`).join('\n');
                if (errors.length > 5) {
                    finalContent += `\n• ... 还有 ${errors.length - 5} 个错误`;
                }
            }

            if (foundMessages === 0) {
                finalContent += `🎉 **没有发现模糊匹配的补卡消息！**`;
            }

            await interaction.editReply({
                content: finalContent
            });

            console.log('\n=== 模糊匹配清理完成 ===');
            console.log(`扫描: ${scannedThreads}, 发现: ${foundMessages}, ${dryRun ? '可删除' : '已删除'}: ${dryRun ? foundMessages : deletedMessages}`);

        } catch (error) {
            console.error('清理操作失败:', error);
            await interaction.editReply({
                content: `❌ **清理操作失败**\n\n错误信息: ${error.message}`
            });
        }
    },

    /**
     * 获取机器人发送的消息
     */
    async fetchBotMessages(channel, botUserId, cutoffDate) {
        const messages = [];
        let lastMessageId = null;

        try {
            while (messages.length < 1000) { // 限制最多获取1000条消息
                const fetchOptions = { limit: 100 };
                if (lastMessageId) {
                    fetchOptions.before = lastMessageId;
                }

                const batch = await channel.messages.fetch(fetchOptions);
                if (batch.size === 0) break;

                const botMessages = batch.filter(message => {
                    // 过滤机器人发送的消息
                    if (message.author.id !== botUserId) return false;
                    
                    // 时间过滤
                    if (cutoffDate && message.createdAt > cutoffDate) return false;
                    
                    return true;
                });

                messages.push(...botMessages.values());
                lastMessageId = batch.last().id;

                // 如果获取的消息少于100条，说明已经到达历史末尾
                if (batch.size < 100) break;
            }
        } catch (error) {
            console.error('获取消息失败:', error);
        }

        return messages;
    },

    /**
     * 判断是否为模糊匹配消息
     */
    isFuzzyMatchMessage(message) {
        if (!message.embeds || message.embeds.length === 0) return false;

        const embed = message.embeds[0];
        
        // 检查是否为补卡系统的消息
        if (!embed.footer || !embed.footer.text || !embed.footer.text.includes('补卡系统')) {
            return false;
        }

        // 检查标题是否为角色卡补充
        if (embed.title !== '📸 角色卡补充') {
            return false;
        }

        // 检查字段中是否包含"模糊匹配"
        if (embed.fields && embed.fields.length > 0) {
            const fileInfoField = embed.fields.find(field => 
                field.name === '📁 文件信息' && 
                field.value && 
                field.value.includes('模糊匹配')
            );
            
            if (fileInfoField) {
                return true;
            }

            // 检查是否有匹配度字段（模糊匹配特有）
            const similarityField = embed.fields.find(field => field.name === '🎯 匹配度');
            if (similarityField) {
                return true;
            }
        }

        return false;
    }
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
} 