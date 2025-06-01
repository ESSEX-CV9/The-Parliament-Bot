const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { addBannedKeyword } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('添加违禁关键字')
        .setNameLocalizations({
            'en-US': 'add-banned-keyword'
        })
        .setDescription('添加一个违禁关键字到自动清理列表')
        .addStringOption(option =>
            option.setName('关键字')
                .setNameLocalizations({ 'en-US': 'keyword' })
                .setDescription('要添加的违禁关键字（支持正则表达式，格式：/pattern/）')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const keyword = interaction.options.getString('关键字');
            const guildId = interaction.guild.id;

            // 验证关键字
            if (!keyword || keyword.trim().length === 0) {
                return await interaction.editReply({
                    content: '❌ 关键字不能为空！',
                    ephemeral: true
                });
            }

            if (keyword.length > 100) {
                return await interaction.editReply({
                    content: '❌ 关键字长度不能超过100个字符！',
                    ephemeral: true
                });
            }

            // 验证正则表达式格式
            if (keyword.startsWith('/') && keyword.endsWith('/')) {
                try {
                    new RegExp(keyword.slice(1, -1), 'i');
                } catch (regexError) {
                    return await interaction.editReply({
                        content: '❌ 无效的正则表达式格式！请检查语法。',
                        ephemeral: true
                    });
                }
            }

            // 添加关键字
            const settings = await addBannedKeyword(guildId, keyword);

            // 检查是否已存在
            const keywordCount = settings.bannedKeywords.filter(k => k === keyword).length;
            if (keywordCount > 1) {
                // 如果重复了，移除重复的
                settings.bannedKeywords = [...new Set(settings.bannedKeywords)];
                await require('../../../core/utils/database').saveAutoCleanupSettings(guildId, settings);
                
                return await interaction.editReply({
                    content: '⚠️ 该关键字已存在于列表中！',
                    ephemeral: true
                });
            }

            const embed = {
                title: '✅ 违禁关键字已添加',
                description: `成功添加违禁关键字：\`${keyword}\``,
                fields: [
                    {
                        name: '当前违禁关键字数量',
                        value: `${settings.bannedKeywords.length}`,
                        inline: true
                    },
                    {
                        name: '类型',
                        value: keyword.startsWith('/') && keyword.endsWith('/') ? '正则表达式' : '普通关键字',
                        inline: true
                    }
                ],
                color: 0x00ff00,
                timestamp: new Date().toISOString()
            };

            console.log(`✅ 添加违禁关键字 - Guild: ${guildId}, Keyword: ${keyword}, User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('添加违禁关键字时出错:', error);
            
            const errorMessage = error.message || '添加违禁关键字时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 