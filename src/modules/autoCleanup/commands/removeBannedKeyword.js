const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { removeBannedKeyword, getBannedKeywords } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-移除违禁关键字')
        .setNameLocalizations({
            'en-US': 'remove-banned-keyword'
        })
        .setDescription('从自动清理列表中移除一个违禁关键字')
        .addStringOption(option =>
            option.setName('关键字')
                .setNameLocalizations({ 'en-US': 'keyword' })
                .setDescription('要移除的违禁关键字')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async autocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const guildId = interaction.guild.id;
            
            const bannedKeywords = await getBannedKeywords(guildId);
            
            const filtered = bannedKeywords
                .filter(keyword => keyword.toLowerCase().includes(focusedValue.toLowerCase()))
                .slice(0, 25); // Discord限制最多25个选项

            await interaction.respond(
                filtered.map(keyword => ({
                    name: keyword.length > 100 ? keyword.substring(0, 97) + '...' : keyword,
                    value: keyword
                }))
            );
        } catch (error) {
            console.error('自动完成违禁关键字时出错:', error);
            await interaction.respond([]);
        }
    },

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const keyword = interaction.options.getString('关键字');
            const guildId = interaction.guild.id;

            // 获取当前关键字列表
            const currentKeywords = await getBannedKeywords(guildId);
            
            if (!currentKeywords.includes(keyword)) {
                return await interaction.editReply({
                    content: '❌ 该关键字不在违禁列表中！',
                    ephemeral: true
                });
            }

            // 移除关键字
            const settings = await removeBannedKeyword(guildId, keyword);

            const embed = {
                title: '✅ 违禁关键字已移除',
                description: `成功移除违禁关键字：\`${keyword}\``,
                fields: [
                    {
                        name: '剩余违禁关键字数量',
                        value: `${settings.bannedKeywords.length}`,
                        inline: true
                    }
                ],
                color: 0x00ff00,
                timestamp: new Date().toISOString()
            };

            console.log(`✅ 移除违禁关键字 - Guild: ${guildId}, Keyword: ${keyword}, User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('移除违禁关键字时出错:', error);
            
            const errorMessage = error.message || '移除违禁关键字时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 