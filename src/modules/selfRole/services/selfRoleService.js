// src/modules/selfRole/services/selfRoleService.js

const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { getSelfRoleSettings, getUserActivity } = require('../../../core/utils/database');

/**
 * 处理自助身份组申请按钮的点击event
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleSelfRoleButton(interaction) {
    const guildId = interaction.guild.id;
    const settings = await getSelfRoleSettings(guildId);

    if (!settings || !settings.roles || settings.roles.length === 0) {
        return interaction.reply({ content: '❌ 当前没有任何可申请的身份组。', ephemeral: true });
    }

    const memberRoles = interaction.member.roles.cache;
    const options = settings.roles
        .filter(roleConfig => !memberRoles.has(roleConfig.roleId)) // 过滤掉用户已有的身份组
        .map(roleConfig => ({
            label: roleConfig.label,
            description: roleConfig.description || `申请 ${roleConfig.label} 身份组`,
            value: roleConfig.roleId,
        }));

    if (options.length === 0) {
        return interaction.reply({ content: '✅ 您已拥有所有可申请的身份组。', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('self_role_select_menu')
        .setPlaceholder('请选择要申请的身份组...')
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
        content: '请从下面的菜单中选择您想申请的身份组：',
        components: [row],
        ephemeral: true,
    });
}

/**
 * 处理用户在下拉菜单中选择身份组后的提交event
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleSelfRoleSelect(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const selectedRoleIds = interaction.values;

    const settings = await getSelfRoleSettings(guildId);
    const userActivity = await getUserActivity(guildId);

    let results = [];

    for (const roleId of selectedRoleIds) {
        const roleConfig = settings.roles.find(r => r.roleId === roleId);
        if (!roleConfig) continue;

        const { conditions } = roleConfig;
        let canApply = true;
        let reason = '';

        // 1. 检查前置身份组
        if (conditions.prerequisiteRoleId && !member.roles.cache.has(conditions.prerequisiteRoleId)) {
            canApply = false;
            const requiredRole = await interaction.guild.roles.fetch(conditions.prerequisiteRoleId);
            reason = `需要拥有 **${requiredRole.name}** 身份组。`;
        }

        // 2. 检查活跃度
        if (canApply && conditions.activity) {
            const { channelId, requiredMessages, requiredMentions } = conditions.activity;
            const activity = userActivity[channelId]?.[member.id] || { messageCount: 0, mentionedCount: 0 };
            
            if (activity.messageCount < requiredMessages && activity.mentionedCount < requiredMentions) {
                canApply = false;
                const channel = await interaction.guild.channels.fetch(channelId);
                reason = `在 <#${channel.id}> 频道中，需要 **${requiredMessages}** 发言数 (您有 ${activity.messageCount}) 或 **${requiredMentions}** 被提及数 (您有 ${activity.mentionedCount})。`;
            }
        }

        // 授予身份组
        if (canApply) {
            try {
                await member.roles.add(roleId);
                results.push(`✅ **${roleConfig.label}**: 成功获取！`);
            } catch (error) {
                console.error(`[SelfRole] ❌ 授予身份组 ${roleConfig.label} 时出错:`, error);
                results.push(`❌ **${roleConfig.label}**: 授予失败，可能是机器人权限不足。`);
            }
        } else {
            results.push(`❌ **${roleConfig.label}**: 申请失败，原因：${reason}`);
        }
    }

    await interaction.editReply({
        content: `**身份组申请结果:**\n\n${results.join('\n')}`,
    });
}

module.exports = {
    handleSelfRoleButton,
    handleSelfRoleSelect,
};