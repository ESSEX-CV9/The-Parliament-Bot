const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getAutoCleanupSettings, saveAutoCleanupSettings } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('切换自动清理')
        .setNameLocalizations({
            'en-US': 'toggle-auto-cleanup'
        })
        .setDescription('启用或禁用自动清理功能')
        .addBooleanOption(option =>
            option.setName('启用')
                .setNameLocalizations({ 'en-US': 'enable' })
                .setDescription('是否启用自动清理功能')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const enable = interaction.options.getBoolean('启用');
            const guildId = interaction.guild.id;

            // 获取当前设置
            const settings = await getAutoCleanupSettings(guildId);
            
            // 更新设置
            settings.isEnabled = enable;
            await saveAutoCleanupSettings(guildId, settings);

            const embed = new EmbedBuilder()
                .setTitle(enable ? '✅ 自动清理已启用' : '❌ 自动清理已禁用')
                .setDescription(enable 
                    ? '自动清理功能已启用。新消息将被自动检查和清理。' 
                    : '自动清理功能已禁用。不会自动清理任何消息。')
                .setColor(enable ? 0x00ff00 : 0xff0000)
                .setTimestamp();

            // 添加设置概览
            embed.addFields(
                { name: '违禁关键字', value: `${settings.bannedKeywords.length} 个`, inline: true },
                { name: '监控频道', value: settings.monitorChannels.length > 0 ? `${settings.monitorChannels.length} 个指定频道` : '所有频道', inline: true }
            );

            if (enable && settings.bannedKeywords.length === 0) {
                embed.addFields({
                    name: '⚠️ 提醒',
                    value: '请使用 `/添加违禁关键字` 命令设置要清理的关键字。',
                    inline: false
                });
            }

            console.log(`🔄 切换自动清理 - Guild: ${guildId}, Enabled: ${enable}, User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('切换自动清理时出错:', error);
            
            const errorMessage = error.message || '切换自动清理时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 