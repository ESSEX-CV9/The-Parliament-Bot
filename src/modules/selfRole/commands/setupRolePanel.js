// src/modules/selfRole/commands/setupRolePanel.js

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
} = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const {
    getSelfRoleSettings,
    getActiveSelfRolePanels,
    registerSelfRolePanelMessage,
} = require('../../../core/utils/database');
const {
    buildCompactStatusLines,
    buildRichDetailLines,
    upsertStatusSection,
    STATUS_SECTION_HEADER,
    DETAIL_SECTION_HEADER,
} = require('../services/panelService');

function extractRoleIdsFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const ids = raw.match(/\d{17,20}/g) || [];
    return [...new Set(ids.map(s => s.trim()).filter(Boolean))];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-创建自助身份组面板')
        .setDescription('在当前频道创建一个自助身份组的申请入口')
        .addStringOption(option =>
            option.setName('标题')
                .setDescription('面板的标题')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('描述')
                .setDescription('面板的描述内容')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('按钮文字')
                .setDescription('按钮上显示的文字')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('详细模式')
                .setDescription('是否启用详细模式（会额外展示“岗位详情”区块）')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('可申请身份组')
                .setDescription('限制该面板可申请/展示的身份组（粘贴 @身份组 或 ID，多个用空格/逗号/换行分隔；留空=全部已配置身份组）')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('停用旧面板')
                .setDescription('是否停用本服务器其它自助身份组申请面板（旧行为：同类只保留一个 active）')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('描述') || '点击下方的按钮开始申请身份组。';
            const buttonText = interaction.options.getString('按钮文字') || '申请身份组';
            const richMode = interaction.options.getBoolean('详细模式') || false;
            const roleListText = interaction.options.getString('可申请身份组');
            const deactivateOldPanels = interaction.options.getBoolean('停用旧面板') || false;

            const guildId = interaction.guild.id;

            // 1) 生成面板内容（现任/空缺/待审核 + 可选“岗位详情”）
            const settings = await getSelfRoleSettings(guildId);

            // role 范围：留空=全部；否则仅展示指定集合
            let panelRoleIds = null;
            if (roleListText) {
                const picked = extractRoleIdsFromText(roleListText);
                const configured = new Set((settings?.roles || []).map(r => r?.roleId).filter(Boolean));
                const ok = picked.filter(rid => configured.has(rid));
                if (ok.length === 0) {
                    await interaction.editReply({
                        content: '❌ 你提供的身份组列表中，没有任何一个已配置为“可自助申请岗位”的身份组。\n\n请先使用 /自助身份组申请-配置向导 或 /自助身份组申请-配置身份组 完成岗位配置。',
                    });
                    return;
                }
                panelRoleIds = ok;
            }

            // 可选：停用旧面板（旧行为）
            let disabledOldCount = 0;
            if (deactivateOldPanels) {
                const oldPanels = await getActiveSelfRolePanels(guildId, 'user');
                for (const p of oldPanels) {
                    try {
                        const ch = await interaction.guild.channels.fetch(p.channelId).catch(() => null);
                        if (!ch || !ch.isTextBased()) continue;
                        const oldMsg = await ch.messages.fetch(p.messageId).catch(() => null);
                        if (!oldMsg) continue;
                        await oldMsg.edit({ components: [] }).catch(() => {});
                        disabledOldCount++;
                    } catch (_) {
                        // 忽略单条失败，继续处理其他面板
                    }
                }
            }

            const statusLines = await buildCompactStatusLines(interaction.guild, settings, { roleIds: panelRoleIds });

            const baseEmbed = new EmbedBuilder()
                .setTitle(title)
                .setColor(0x5865F2);

            let embeds = [];

            if (richMode) {
                // Rich：静态说明 + 状态区 embed + 详情区 embed
                const detailLines = await buildRichDetailLines(interaction.guild, settings, { roleIds: panelRoleIds });

                baseEmbed.setDescription(description);

                const statusEmbed = new EmbedBuilder()
                    .setTitle(STATUS_SECTION_HEADER)
                    .setDescription(statusLines.join('\n'))
                    .setColor(0x5865F2);

                const detailEmbed = new EmbedBuilder()
                    .setTitle(DETAIL_SECTION_HEADER)
                    .setDescription(detailLines.join('\n'))
                    .setColor(0x5865F2);

                embeds = [baseEmbed, statusEmbed, detailEmbed];
            } else {
                // 旧模式：在同一 embed.description 中维护状态区块
                const fullDescription = upsertStatusSection(description, statusLines);
                baseEmbed.setDescription(fullDescription);
                embeds = [baseEmbed];
            }

            const applyButton = new ButtonBuilder()
                // v2 面板按钮 ID（保留旧按钮 self_role_apply_button 兼容，但新面板统一使用 sr2_apply_button）
                .setCustomId('sr2_apply_button')
                .setLabel(buttonText)
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(applyButton);

            const sent = await interaction.channel.send({ embeds, components: [row] });

            // 2) 注册新面板
            // - 若“停用旧面板”开启：保持旧行为（同类型只保留一个 active）
            // - 否则：允许同一服务器存在多个用户面板（不同频道可配置不同可申请身份组集合）
            await registerSelfRolePanelMessage(guildId, interaction.channel.id, sent.id, 'user', {
                deactivateExisting: deactivateOldPanels,
                roleIds: panelRoleIds,
            });

            console.log(`[SelfRole] ✅ 在频道 ${interaction.channel.name} 成功创建自助身份组申请面板。`);
            const suffix = disabledOldCount > 0 ? `（已停用旧面板 ${disabledOldCount} 个）` : '';
            await interaction.editReply({ content: `✅ 申请面板已成功创建！${suffix}` });

        } catch (error) {
            console.error('[SelfRole] ❌ 创建自助身份组面板时出错:', error);
            await interaction.editReply({ content: '❌ 创建面板时发生错误，请检查机器人是否拥有在此频道发送消息的权限。' });
        }
    },
};