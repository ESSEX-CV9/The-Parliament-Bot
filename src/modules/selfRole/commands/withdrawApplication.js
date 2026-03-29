// src/modules/selfRole/commands/withdrawApplication.js

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');

const {
    listPendingSelfRoleApplicationsV2ByApplicant,
    resolveSelfRoleApplicationV2,
    deleteSelfRoleApplication,
} = require('../../../core/utils/database');

const { checkExpiredSelfRoleApplications } = require('../services/applicationChecker');
const { scheduleActiveUserSelfRolePanelsRefresh } = require('../services/panelService');

function formatDateTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return String(ts);
    }
}

function buildDisabledRows(message) {
    if (!message?.components || message.components.length === 0) {
        return [];
    }

    return message.components.map(row => {
        const disabledButtons = row.components.map(component => {
            try {
                return ButtonBuilder.from(component).setDisabled(true);
            } catch (_) {
                return component;
            }
        });
        return new ActionRowBuilder().addComponents(disabledButtons);
    });
}

async function markReviewMessageWithdrawn(client, application) {
    if (!application?.reviewChannelId || !application?.reviewMessageId) return;

    const channel = await client.channels.fetch(application.reviewChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(application.reviewMessageId).catch(() => null);
    if (!message) return;

    const originalEmbed = message.embeds?.[0];
    if (!originalEmbed) {
        await message.edit({ components: [] }).catch(() => {});
        return;
    }

    const updated = new EmbedBuilder(originalEmbed.data)
        .setColor(0x747F8D)
        .setDescription(
            (() => {
                const base = (originalEmbed.description || '').trim();
                const extra = '🚫 **申请人已撤回申请**，系统已释放预留名额。';
                const next = base ? `${base}\n\n${extra}` : extra;
                return next.length > 4096 ? next.slice(0, 4093) + '…' : next;
            })(),
        )
        .setFields(
            ...originalEmbed.fields.map(field => {
                if (field.name === '状态') {
                    return { ...field, value: '🚫 已撤回' };
                }
                return field;
            }),
        );

    await message.edit({ embeds: [updated], components: buildDisabledRows(message) }).catch(() => {});
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-撤回申请')
        .setDescription('撤回你尚未处理完毕的身份组申请（将释放预留名额）')
        .addRoleOption(opt =>
            opt
                .setName('目标身份组')
                .setDescription('要撤回申请的目标身份组（不填则展示你的待审核申请列表）')
                .setRequired(false),
        ),

    /**
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const roleOpt = interaction.options.getRole('目标身份组');

        // 先做一次过期清理，避免用户看到“其实已过期”的 pending
        await checkExpiredSelfRoleApplications(interaction.client).catch(() => {});

        const pendings = await listPendingSelfRoleApplicationsV2ByApplicant(guildId, userId);

        if (!pendings || pendings.length === 0) {
            await interaction.editReply({ content: '✅ 你当前没有待审核的身份组申请。' });
            return;
        }

        let target = null;

        if (roleOpt) {
            target = pendings.find(a => a && a.roleId === roleOpt.id) || null;
            if (!target) {
                await interaction.editReply({ content: '❌ 未找到你对该身份组的待审核申请。' });
                return;
            }
        } else if (pendings.length === 1) {
            target = pendings[0];
        }

        if (!target) {
            const lines = pendings
                .filter(Boolean)
                .map(a => {
                    const expireText = a.reservedUntil ? `（过期：${formatDateTime(a.reservedUntil)}）` : '';
                    return `• <@&${a.roleId}> ${expireText}`;
                });

            const embed = new EmbedBuilder()
                .setTitle('📌 你的待审核申请')
                .setDescription(`${lines.join('\n')}\n\n请重新执行命令并指定「目标身份组」以撤回其中一个申请。`)
                .setColor(0x5865F2);

            await interaction.editReply({ embeds: [embed] });
            return;
        }

        // 执行撤回
        await resolveSelfRoleApplicationV2(target.applicationId, 'withdrawn', 'withdrawn_by_user', Date.now());

        if (target.reviewMessageId) {
            // 终止 legacy 投票记录，避免继续投票
            await deleteSelfRoleApplication(target.reviewMessageId).catch(() => {});
        }

        await markReviewMessageWithdrawn(interaction.client, target).catch(() => {});

        scheduleActiveUserSelfRolePanelsRefresh(interaction.client, guildId, 'application_withdrawn');

        await interaction.editReply({
            content: `✅ 已撤回你对 <@&${target.roleId}> 的申请，并释放预留名额。`,
        });
    },
};
