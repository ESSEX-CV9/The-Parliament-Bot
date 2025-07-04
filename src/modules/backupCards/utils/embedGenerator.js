// src/modules/backupCards/utils/embedGenerator.js

class EmbedGenerator {
    constructor() {
        this.colors = {
            success: 0x00ff00,    // 绿色 - 成功/文件
            info: 0x0099ff,       // 蓝色 - 信息/链接
            warning: 0xffaa00,    // 橙色 - 警告/文字描述
            error: 0xff0000,      // 红色 - 错误
            neutral: 0x808080     // 灰色 - 中性
        };
    }

    /**
     * 生成文件补充的Embed消息
     */
    generateFileEmbed(contentItem, fileResult, backupItem) {
        const embed = {
            title: '📸 角色卡补充',
            color: this.colors.success,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: `补卡系统 • 行 ${backupItem.rowNumber}`
            }
        };

        // 基本信息
        embed.fields.push({
            name: '📝 帖子信息',
            value: `**标题**: ${backupItem.title || '未知'}\n**帖子ID**: ${backupItem.threadId}`,
            inline: false
        });

        // 文件信息
        if (fileResult && fileResult.length > 0) {
            const file = fileResult[0]; // 使用第一个匹配的文件
            embed.fields.push({
                name: '📁 文件信息',
                value: `**文件名**: ${contentItem.fileName}\n**位置**: ${file.location}\n**匹配类型**: ${this.getMatchTypeText(file.matchType)}`,
                inline: true
            });

            // embed.fields.push({
            //     name: '📂 文件路径',
            //     value: `\`${file.path}\``,
            //     inline: false
            // });

            // 如果是模糊匹配，显示相似度
            if (file.matchType === 'fuzzy') {
                embed.fields.push({
                    name: '🎯 匹配度',
                    value: `${Math.round(file.similarity * 100)}%`,
                    inline: true
                });
            }
        } else {
            embed.color = this.colors.error;
            embed.fields.push({
                name: '❌ 文件状态',
                value: `文件未找到: ${contentItem.fileName}`,
                inline: false
            });
        }

        return embed;
    }

    /**
     * 生成文字描述的Embed消息
     */
    generateTextDescriptionEmbed(contentItem, backupItem) {
        const embed = {
            title: '📝 补卡说明',
            color: this.colors.warning,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: `补卡系统 • 行 ${backupItem.rowNumber}`
            }
        };

        // 基本信息
        embed.fields.push({
            name: '📝 帖子信息',
            value: `**标题**: ${backupItem.title || '未知'}\n**帖子ID**: ${backupItem.threadId}`,
            inline: false
        });

        // 描述内容
        embed.fields.push({
            name: '💬 说明内容',
            value: contentItem.originalContent,
            inline: false
        });

        // 分类信息
        const categoryText = this.getCategoryText(contentItem.category);
        embed.fields.push({
            name: '🏷️ 类型',
            value: categoryText,
            inline: true
        });

        // 根据类型设置描述
        embed.description = this.getCategoryDescription(contentItem.category);

        return embed;
    }

    /**
     * 生成Discord链接的Embed消息
     */
    generateDiscordLinkEmbed(contentItem, backupItem) {
        const embed = {
            title: '🔗 已在其他位置补充',
            color: this.colors.info,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: `补卡系统 • 行 ${backupItem.rowNumber}`
            }
        };

        // 基本信息
        embed.fields.push({
            name: '📝 帖子信息',
            value: `**标题**: ${backupItem.title || '未知'}\n**帖子ID**: ${backupItem.threadId}`,
            inline: false
        });

        // 链接信息
        embed.fields.push({
            name: '🔗 外部链接',
            value: `发现 ${contentItem.links.length} 个Discord链接`,
            inline: true
        });

        // 如果有额外文字描述
        if (contentItem.hasAdditionalText) {
            const additionalText = contentItem.originalContent.replace(this.discordLinkPattern, '').trim();
            embed.fields.push({
                name: '💬 补充说明',
                value: additionalText,
                inline: false
            });
        }

        embed.description = '角色卡已在其他Discord服务器或频道中补充完成';

        return embed;
    }

    /**
     * 生成错误/未知内容的Embed消息
     */
    generateErrorEmbed(contentItem, backupItem, errorMessage) {
        const embed = {
            title: '❌ 处理失败',
            color: this.colors.error,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: `补卡系统 • 行 ${backupItem.rowNumber}`
            }
        };

        // 基本信息
        embed.fields.push({
            name: '📝 帖子信息',
            value: `**标题**: ${backupItem.title || '未知'}\n**帖子ID**: ${backupItem.threadId}`,
            inline: false
        });

        // 原始内容
        embed.fields.push({
            name: '📄 原始内容',
            value: `\`${contentItem.originalContent}\``,
            inline: false
        });

        // 错误信息
        if (errorMessage) {
            embed.fields.push({
                name: '❌ 错误信息',
                value: errorMessage,
                inline: false
            });
        }

        embed.description = '无法识别或处理此补卡内容';

        return embed;
    }

    /**
     * 生成进度跟踪的Embed消息
     */
    generateProgressEmbed(stats, currentIndex, totalItems) {
        const embed = {
            title: '📊 补卡处理进度',
            color: this.colors.info,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: '补卡系统进度报告'
            }
        };

        // 进度信息
        const percentage = Math.round((currentIndex / totalItems) * 100);
        embed.fields.push({
            name: '📈 当前进度',
            value: `${currentIndex}/${totalItems} (${percentage}%)`,
            inline: true
        });

        // 处理统计
        embed.fields.push({
            name: '✅ 成功处理',
            value: `${stats.processed || 0} 项`,
            inline: true
        });

        embed.fields.push({
            name: '❌ 处理失败',
            value: `${stats.failed || 0} 项`,
            inline: true
        });

        embed.fields.push({
            name: '📁 文件补充',
            value: `${stats.files || 0} 个`,
            inline: true
        });

        embed.fields.push({
            name: '💬 文字说明',
            value: `${stats.textDescriptions || 0} 个`,
            inline: true
        });

        embed.fields.push({
            name: '🔗 外部链接',
            value: `${stats.discordLinks || 0} 个`,
            inline: true
        });

        // 添加归档统计（如果有的话）
        if (stats.archived !== undefined) {
            embed.fields.push({
                name: '📦 已归档',
                value: `${stats.archived || 0} 个帖子`,
                inline: true
            });
        }

        return embed;
    }

    /**
     * 生成最终完成报告的Embed消息
     */
    generateCompletionEmbed(stats, startTime, endTime) {
        const duration = Math.round((endTime - startTime) / 1000);
        const embed = {
            title: '🎉 补卡处理完成',
            color: this.colors.success,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: {
                text: '补卡系统完成报告'
            }
        };

        // 总体统计
        embed.fields.push({
            name: '📊 处理统计',
            value: `**总处理数**: ${stats.total || 0}\n**成功**: ${stats.processed || 0}\n**失败**: ${stats.failed || 0}`,
            inline: true
        });

        // 类型统计
        embed.fields.push({
            name: '📋 类型分布',
            value: `**文件**: ${stats.files || 0}\n**文字**: ${stats.textDescriptions || 0}\n**链接**: ${stats.discordLinks || 0}`,
            inline: true
        });

        // 时间统计
        embed.fields.push({
            name: '⏱️ 处理时间',
            value: `${duration} 秒`,
            inline: true
        });

        // 添加归档统计（如果有的话）
        if (stats.archived !== undefined) {
            embed.fields.push({
                name: '📦 归档统计',
                value: `${stats.archived || 0} 个帖子已自动归档`,
                inline: false
            });
        }

        embed.description = '所有补卡项目处理完成！';

        return embed;
    }

    /**
     * 获取匹配类型的文本描述
     */
    getMatchTypeText(matchType) {
        const types = {
            'exact': '精确匹配',
            'fuzzy': '模糊匹配',
            'fallback': '后备搜索',
            'recursive': '子目录搜索'
        };
        return types[matchType] || '未知';
    }

    /**
     * 获取分类的文本描述
     */
    getCategoryText(category) {
        const categories = {
            'author_self_backup': '作者自补',
            'cloud_storage': '网盘资源',
            'no_match_needed': '无需匹配',
            'source_match_failed': '匹配失败',
            'other': '其他说明'
        };
        return categories[category] || '未分类';
    }

    /**
     * 获取分类的详细描述
     */
    getCategoryDescription(category) {
        const descriptions = {
            'author_self_backup': '原作者已经自行补充了角色卡',
            'cloud_storage': '角色卡存储在网盘中',
            'no_match_needed': '此项无需进行角色卡匹配',
            'source_match_failed': '源文档匹配失败，已在其他位置处理',
            'other': '其他类型的补卡说明'
        };
        return descriptions[category] || '未分类的补卡说明';
    }
}

module.exports = EmbedGenerator; 