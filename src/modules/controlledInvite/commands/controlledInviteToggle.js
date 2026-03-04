const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const {
    getConfigsByMainGuild,
    setEnabled,
} = require('../utils/controlledInviteDatabase');

// ========== 命令定义 ==========

const data = new SlashCommandBuilder()
    .setName('受控邀请开关')
    .setDescription('快速开关受控邀请系统（不影响配置数据）')
    .setDefaultMemberPermissions(0)

    .addStringOption(opt => opt
        .setName('操作')
        .setDescription('开启或关闭')
        .setRequired(true)
        .addChoices(
            { name: '🟢 开启', value: 'on' },
            { name: '🔴 关闭', value: 'off' },
        )
    )
    .addStringOption(opt => opt
        .setName('分服务器id')
        .setDescription('指定分服（不填则操作所有分服）')
        .setRequired(false)
    );

// ========== 命令执行 ==========

async function execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const mainGuildId = interaction.guild.id;
    const action = interaction.options.getString('操作');
    const subGuildId = interaction.options.getString('分服务器id');
    const enabled = action === 'on';

    try {
        const configs = getConfigsByMainGuild(mainGuildId);

        if (configs.length === 0) {
            await interaction.editReply('❌ 当前主服没有绑定任何分服');
            return;
        }

        if (subGuildId) {
            // 操作指定分服
            const config = configs.find(c => c.sub_guild_id === subGuildId);
            if (!config) {
                await interaction.editReply(`❌ 未找到分服 \`${subGuildId}\` 的绑定配置`);
                return;
            }

            if (config.enabled === (enabled ? 1 : 0)) {
                await interaction.editReply(`ℹ️ 分服 \`${subGuildId}\` 的受控邀请已经${enabled ? '开启' : '关闭'}了`);
                return;
            }

            setEnabled(mainGuildId, subGuildId, enabled);

            const subGuild = await interaction.client.guilds.fetch(subGuildId).catch(() => null);
            const subName = subGuild ? subGuild.name : subGuildId;

            const embed = new EmbedBuilder()
                .setTitle(enabled ? '🟢 受控邀请已开启' : '🔴 受控邀请已关闭')
                .setDescription([
                    `**分服**: ${subName} (\`${subGuildId}\`)`,
                    '',
                    enabled
                        ? '✅ Bot 将恢复监控该分服的入服事件和邀请码申请'
                        : '⏸️ Bot 将停止监控该分服的入服事件和邀请码申请\n> 配置数据已保留，重新开启后立即恢复',
                ].join('\n'))
                .setColor(enabled ? 0x57F287 : 0xED4245)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } else {
            // 操作所有分服
            let changed = 0;
            for (const config of configs) {
                if (config.enabled !== (enabled ? 1 : 0)) {
                    setEnabled(mainGuildId, config.sub_guild_id, enabled);
                    changed++;
                }
            }

            if (changed === 0) {
                await interaction.editReply(`ℹ️ 所有分服的受控邀请已经${enabled ? '开启' : '关闭'}了`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(enabled ? '🟢 受控邀请已全部开启' : '🔴 受控邀请已全部关闭')
                .setDescription([
                    `**影响分服数**: ${changed} / ${configs.length}`,
                    '',
                    enabled
                        ? '✅ Bot 将恢复监控所有分服的入服事件和邀请码申请'
                        : '⏸️ Bot 将停止监控所有分服的入服事件和邀请码申请\n> 配置数据已保留，重新开启后立即恢复',
                ].join('\n'))
                .setColor(enabled ? 0x57F287 : 0xED4245)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (err) {
        console.error('[ControlledInvite][Toggle] 命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
