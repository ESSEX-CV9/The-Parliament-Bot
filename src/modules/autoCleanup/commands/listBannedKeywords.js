const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getBannedKeywords } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-查看违禁关键字')
        .setNameLocalizations({
            'en-US': 'list-banned-keywords'
        })
        .setDescription('查看当前服务器的所有违禁关键字')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            const bannedKeywords = await getBannedKeywords(guildId);

            if (bannedKeywords.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('📋 违禁关键字列表')
                    .setDescription('当前没有设置任何违禁关键字。')
                    .setColor(0xffa500)
                    .setTimestamp();

                return await interaction.editReply({
                    embeds: [embed],
                    ephemeral: true
                });
            }

            // 分页显示关键字（每页10个）
            const pageSize = 10;
            const totalPages = Math.ceil(bannedKeywords.length / pageSize);
            const currentPage = 1; // 默认第一页

            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const currentKeywords = bannedKeywords.slice(startIndex, endIndex);

            const embed = new EmbedBuilder()
                .setTitle('📋 违禁关键字列表')
                .setDescription(`服务器 **${interaction.guild.name}** 的违禁关键字`)
                .setColor(0x00ff00)
                .setTimestamp();

            // 添加关键字字段
            let keywordList = '';
            currentKeywords.forEach((keyword, index) => {
                const globalIndex = startIndex + index + 1;
                const type = keyword.startsWith('/') && keyword.endsWith('/') ? '正则' : '普通';
                const displayKeyword = keyword.length > 50 ? keyword.substring(0, 47) + '...' : keyword;
                keywordList += `**${globalIndex}.** \`${displayKeyword}\` (${type})\n`;
            });

            embed.addFields(
                { name: '关键字列表', value: keywordList || '无', inline: false },
                { name: '📊 统计信息', value: `总计: ${bannedKeywords.length} 个关键字`, inline: true }
            );

            if (totalPages > 1) {
                embed.addFields({
                    name: '📄 分页信息',
                    value: `第 ${currentPage}/${totalPages} 页`,
                    inline: true
                });
            }

            // 统计正则表达式和普通关键字数量
            const regexCount = bannedKeywords.filter(k => k.startsWith('/') && k.endsWith('/')).length;
            const normalCount = bannedKeywords.length - regexCount;
            
            embed.addFields({
                name: '📈 类型分布',
                value: `普通: ${normalCount} | 正则: ${regexCount}`,
                inline: true
            });

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('查看违禁关键字时出错:', error);
            
            const errorMessage = error.message || '查看违禁关键字时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 