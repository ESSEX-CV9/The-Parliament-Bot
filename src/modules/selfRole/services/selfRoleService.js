// src/modules/selfRole/services/selfRoleService.js

const { randomUUID } = require('crypto');
const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const {
    getSelfRoleSettings,
    getUserActivity,
    getUserActiveDaysCount,
    saveSelfRoleApplication,
    deleteSelfRoleApplication,
    getPendingApplicationByApplicantRole,
    getSelfRoleCooldown,
    countActiveSelfRoleGrantHoldersByRole,
    countReservedPendingSelfRoleApplicationsV2,
    getSelfRolePanel,
    getPendingSelfRoleApplicationV2ByApplicantRole,
    saveSelfRoleApplicationV2,
    resolveSelfRoleApplicationV2,
    createSelfRoleGrant,
} = require('../../../core/utils/database');

const { scheduleActiveUserSelfRolePanelsRefresh } = require('./panelService');
const { checkExpiredSelfRoleApplications } = require('./applicationChecker');

const DEFAULT_PENDING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

function formatDateTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return String(ts);
    }
}

/**
 * 处理用户点击“自助身份组申请”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleSelfRoleButton(interaction) {
    // 重要：必须在 3 秒内 ack，否则 Discord 会判定交互失败。
    // 先 defer，再执行可能较慢的 DB/网络操作（如过期清理、统计计算等）。
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const isLegacyPanel = interaction.customId === 'self_role_apply_button';

    // 多面板支持：从“被点击的面板消息”读取该面板的可申请身份组范围。
    // - legacy 面板（self_role_apply_button）无法定位 DB 记录，默认展示全部已配置岗位。
    // - 新面板（sr2_apply_button）若已注册到 sr_panels，可按 roleIds 进行过滤。
    const panelMessageId = interaction.message?.id || null;
    let panelRoleIds = null;
    let panelIsActive = true;

    if (!isLegacyPanel && panelMessageId) {
        const panel = await getSelfRolePanel(panelMessageId).catch(() => null);
        if (panel && panel.panelType === 'user') {
            panelIsActive = !!panel.isActive;
            if (!panelIsActive) {
                await interaction.editReply({ content: '⚠️ 该申请面板已被停用或已过期，请联系管理员重新创建。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            if (Array.isArray(panel.roleIds)) {
                panelRoleIds = panel.roleIds;
            }
        }
    }

    const panelRoleFilter = Array.isArray(panelRoleIds) ? new Set(panelRoleIds) : null;

    // 清理过期申请，避免面板“空缺/待审核”统计长期不释放
    await checkExpiredSelfRoleApplications(interaction.client).catch(() => {});

    const settings = await getSelfRoleSettings(guildId);

    if (!settings || !settings.roles || settings.roles.length === 0) {
        await interaction.editReply({ content: '❌ 当前没有任何可申请的身份组。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const memberRoles = interaction.member.roles.cache;

    // 仅展示“仍有空缺”的身份组（有上限时），避免用户选择后才被告知满员
    const options = [];
    const nowMs = Date.now();
    for (const roleConfig of settings.roles) {
        if (!roleConfig?.roleId) continue;
        if (panelRoleFilter && !panelRoleFilter.has(roleConfig.roleId)) continue;
        if (memberRoles.has(roleConfig.roleId)) continue;

        const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
        const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
        if (hasLimit) {
            const role = await interaction.guild.roles.fetch(roleConfig.roleId).catch(() => null);
            if (!role) continue;
            const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleConfig.roleId);
            const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleConfig.roleId, nowMs);
            const vacancy = Math.max(0, maxMembers - holders - pendingReserved);
            if (vacancy <= 0) continue;

            let desc = roleConfig.description || `申请 ${roleConfig.label} 身份组`;
            desc = `${desc}（空缺${vacancy}）`;
            if (desc.length > 100) desc = desc.slice(0, 97) + '...';

            options.push({
                label: roleConfig.label,
                description: desc,
                value: roleConfig.roleId,
            });
        } else {
            let desc = roleConfig.description || `申请 ${roleConfig.label} 身份组`;
            if (desc.length > 100) desc = desc.slice(0, 97) + '...';
            options.push({
                label: roleConfig.label,
                description: desc,
                value: roleConfig.roleId,
            });
        }
    }

    if (options.length === 0) {
        await interaction.editReply({ content: 'ℹ️ 当前没有可申请的身份组（可能已满员，或您已拥有所有可申请身份组）。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const selectMenuCustomId = (!isLegacyPanel && panelMessageId && panelIsActive)
        ? `self_role_select_menu:${panelMessageId}`
        : 'self_role_select_menu';

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(selectMenuCustomId)
        .setPlaceholder('请选择要申请的身份组...')
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const legacyNotice = isLegacyPanel
        ? '⚠️ 您正在使用旧版本的申请面板。为避免名额/待审核统计不一致，建议联系管理员重新召唤最新面板。\n\n'
        : '';

    await interaction.editReply({
        content: `${legacyNotice}请从下面的菜单中选择您想申请的身份组：`,
        components: [row],
    });

    // 60秒后自动删除此消息
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 60000);
}

/**
 * 处理用户在下拉菜单中选择身份组后的提交事件。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 字符串选择菜单交互对象。
 */
async function handleSelfRoleSelect(interaction) {
    // 注意：如果要打开 modal，不能先 deferReply，否则 showModal 会报 InteractionAlreadyReplied。
    // 因此：先快速判断是否需要 modal；需要则直接 showModal 并 return；不需要则立刻 defer，再执行耗时逻辑。

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const selectedRoleIds = Array.isArray(interaction.values) ? interaction.values : [];

    // 多面板支持：selectMenu customId 可能携带来源面板 messageId，用于二次校验可申请范围。
    const rawCustomId = String(interaction.customId || '');
    const panelMessageId = rawCustomId.startsWith('self_role_select_menu:')
        ? rawCustomId.replace('self_role_select_menu:', '')
        : null;
    let panelRoleFilter = null;
    if (panelMessageId) {
        const panel = await getSelfRolePanel(panelMessageId).catch(() => null);
        if (panel && panel.panelType === 'user') {
            if (!panel.isActive) {
                await interaction.reply({ content: '⚠️ 该申请面板已被停用或已过期，请重新从最新面板发起申请。', ephemeral: true });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }
            if (Array.isArray(panel.roleIds) && panel.roleIds.length > 0) {
                panelRoleFilter = new Set(panel.roleIds);
            }
        }
    }

    const settings = await getSelfRoleSettings(guildId);
    if (!settings || !Array.isArray(settings.roles) || settings.roles.length === 0) {
        await interaction.reply({ content: '❌ 当前没有任何可申请的身份组。', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    if (!selectedRoleIds || selectedRoleIds.length === 0) {
        await interaction.reply({ content: '❌ 未选择任何身份组，请重试。', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    if (panelRoleFilter) {
        const invalid = selectedRoleIds.filter(rid => !panelRoleFilter.has(rid));
        if (invalid.length > 0) {
            await interaction.reply({
                content: '❌ 你选择的身份组不属于该面板允许申请的范围，请重新从该面板发起申请。',
                ephemeral: true,
            });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
    }

    // 先判断是否需要理由 modal：需要则立刻弹出，避免后续过期清理/统计计算等耗时操作导致 3 秒超时。
    //（SelectMenu 默认 maxValues=1，这里做兼容处理：若多选，优先处理第一个需要理由的身份组。）
    for (const roleId of selectedRoleIds) {
        const roleConfig = settings.roles.find(r => r?.roleId === roleId);
        if (!roleConfig) continue;

        const reasonCfg = roleConfig?.conditions?.reason;
        if (reasonCfg && reasonCfg.mode && reasonCfg.mode !== 'disabled') {
            const placeholder = roleConfig.conditions?.approval
                ? '请详细说明申请该身份组的理由（示例：我在该频道的贡献、参与情况等）'
                : '请说明申请该身份组的理由（可选）';

            const modal = new ModalBuilder()
                .setCustomId(`self_role_reason_modal_${roleId}`)
                .setTitle(`申请理由: ${roleConfig.label}`);

            const reasonInput = new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('申请理由')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(placeholder)
                .setRequired(reasonCfg.mode === 'required');

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
            return;
        }
    }

    // 不需要 modal 的路径：先 ack
    await interaction.deferReply({ ephemeral: true });

    // 过期清理可能包含 Discord API 编辑消息等操作，可能较慢；因此必须在 defer 之后执行。
    await checkExpiredSelfRoleApplications(interaction.client).catch(() => {});

    const userActivity = await getUserActivity(guildId);

    let results = [];

    for (const roleId of selectedRoleIds) {
        const roleConfig = settings.roles.find(r => r.roleId === roleId);
        if (!roleConfig) continue;

        const { conditions } = roleConfig;
        const failureReasons = [];

        // 1. 检查前置身份组
        if (conditions.prerequisiteRoleId && !member.roles.cache.has(conditions.prerequisiteRoleId)) {
            const requiredRole = await interaction.guild.roles.fetch(conditions.prerequisiteRoleId);
            failureReasons.push(`需要拥有 **${requiredRole.name}** 身份组`);
        }

        // 2. 检查活跃度
        if (conditions.activity) {
            const { channelId, requiredMessages, requiredMentions, requiredMentioning, activeDaysThreshold } = conditions.activity;
            const activity = userActivity[channelId]?.[member.id] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
            const channel = await interaction.guild.channels.fetch(channelId).catch(() => ({ id: channelId }));

            if (activity.messageCount < requiredMessages) {
                failureReasons.push(`在 <#${channel.id}> 发言数需达到 **${requiredMessages}** (当前: ${activity.messageCount})`);
            }
            if (activity.mentionedCount < requiredMentions) {
                failureReasons.push(`在 <#${channel.id}> 被提及数需达到 **${requiredMentions}** (当前: ${activity.mentionedCount})`);
            }
            if (activity.mentioningCount < requiredMentioning) {
                failureReasons.push(`在 <#${channel.id}> 主动提及数需达到 **${requiredMentioning}** (当前: ${activity.mentioningCount})`);
            }

            // 3. 检查活跃天数阈值（新功能）
            if (activeDaysThreshold) {
                const { dailyMessageThreshold, requiredActiveDays } = activeDaysThreshold;
                const actualActiveDays = await getUserActiveDaysCount(guildId, channelId, member.id, dailyMessageThreshold);

                if (actualActiveDays < requiredActiveDays) {
                    failureReasons.push(`在 <#${channel.id}> 每日发言超过 **${dailyMessageThreshold}** 条的天数需达到 **${requiredActiveDays}** 天 (当前: ${actualActiveDays} 天)`);
                }
            }
        }

        const canApply = failureReasons.length === 0;

        if (canApply) {
            // 0) 名额检查（现任 + 待审核预留名额）
            const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
            const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
            if (hasLimit) {
                const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (!role) {
                    results.push(`❌ **${roleConfig.label}**: 无法获取身份组信息，可能已被删除或机器人权限不足。`);
                    continue;
                }

                const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
                const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, Date.now());
                if (holders + pendingReserved >= maxMembers) {
                    results.push(`❌ **${roleConfig.label}**: 当前已满员（现任 ${holders}/${maxMembers}，待审核 ${pendingReserved}），暂无空缺，无法申请。`);
                    continue;
                }
            }

            // 如果资格预审通过，检查是否需要审核
            if (conditions.approval) {
                // 1) 防重复逻辑：检查是否已存在“待审核”的同一用户对同一身份组申请
                const existingV2 = await getPendingSelfRoleApplicationV2ByApplicantRole(guildId, member.id, roleId);
                const existingLegacy = await getPendingApplicationByApplicantRole(member.id, roleId);
                if (existingV2 || existingLegacy) {
                    const expireText = existingV2?.reservedUntil
                        ? `（将于 ${formatDateTime(existingV2.reservedUntil)} 自动过期）`
                        : '';
                    results.push(`⏳ **${roleConfig.label}**: 您的身份组申请正在人工审核阶段，请耐心等候${expireText}。如需撤回，请使用 /自助身份组申请-撤回申请。`);
                } else {
                    // 2) 冷却期逻辑：若被拒绝后设置了冷却天数，检查是否仍在冷却期
                    const cooldown = await getSelfRoleCooldown(guildId, roleId, member.id);
                    if (cooldown && cooldown.expiresAt > Date.now()) {
                        const remainingMs = cooldown.expiresAt - Date.now();
                        const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
                        const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                        const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
                        const parts = [];
                        if (days > 0) parts.push(`${days}天`);
                        if (hours > 0) parts.push(`${hours}小时`);
                        if (minutes > 0) parts.push(`${minutes}分钟`);
                        const remainText = parts.length > 0 ? parts.join('') : '不到1分钟';
                        results.push(`❌ **${roleConfig.label}**: 您的身份组申请未通过人工审核，已进入冷却期，还有 ${remainText} 结束。`);
                    } else {
                        // 3) 不在冷却期且不存在待审核记录：创建审核面板
                        try {
                            await createApprovalPanel(interaction, roleConfig, null);
                            results.push(`⏳ **${roleConfig.label}**: 资格审查通过，已提交社区审核。`);
                        } catch (error) {
                            console.error(`[SelfRole] ❌ 创建审核面板时出错 for ${roleConfig.label}:`, error);
                            results.push(`❌ **${roleConfig.label}**: 提交审核失败，请联系管理员。`);
                        }
                    }
                }
            }
            // 如果资格预审通过且无需审核
            else {
                try {
                    const bundleRoleIds = Array.isArray(roleConfig.bundleRoleIds) ? roleConfig.bundleRoleIds : [];
                    const roleIdsToAdd = [...new Set([roleId, ...bundleRoleIds])];
                    await member.roles.add(roleIdsToAdd);

                    try {
                        await createSelfRoleGrant({
                            guildId,
                            userId: member.id,
                            primaryRoleId: roleId,
                            applicationId: null,
                            grantedAt: Date.now(),
                            bundleRoleIds,
                        });
                    } catch (dbErr) {
                        console.error('[SelfRole] ❌ 写入 grant 记录失败（直授）:', dbErr);
                    }

                    const bundleSuffix = bundleRoleIds.length > 0 ? '（含配套身份组）' : '';
                    results.push(`✅ **${roleConfig.label}**: 成功获取！${bundleSuffix}`);
                    scheduleActiveUserSelfRolePanelsRefresh(interaction.client, guildId, 'direct_grant');
                } catch (error) {
                    console.error(`[SelfRole] ❌ 授予身份组 ${roleConfig.label} 时出错:`, error);
                    results.push(`❌ **${roleConfig.label}**: 授予失败，可能是机器人权限不足。`);
                }
            }
        } else {
            // 如果资格预审不通过
            results.push(`❌ **${roleConfig.label}**: 申请失败，原因：${failureReasons.join('； ')}`);
        }
    }

    await interaction.editReply({
        content: `**身份组申请结果:**\n\n${results.join('\n')}`,
    });

    // 60秒后自动删除此消息
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 60000);
}

module.exports = {
    handleSelfRoleButton,
    handleSelfRoleSelect,
    handleReasonModalSubmit,
};

/**
 * 为需要审核的身份组申请创建一个投票面板。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 原始的菜单交互对象。
 * @param {object} roleConfig - 所申请身份组的具体配置。
 */
async function createApprovalPanel(interaction, roleConfig, reasonText) {
    const { approval } = roleConfig.conditions;
    const applicant = interaction.user;
    const role = await interaction.guild.roles.fetch(roleConfig.roleId);

    // 现任口径：仅统计本模块 grant（sr_grants/sr_grant_roles）
    const holders = await countActiveSelfRoleGrantHoldersByRole(interaction.guild.id, roleConfig.roleId);

    // 0) 再次名额检查（防止并发/时序）
    const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
    const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
    if (hasLimit) {
        const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(interaction.guild.id, roleConfig.roleId, Date.now());
        if (holders + pendingReserved >= maxMembers) {
            throw new Error('该身份组已满员（含待审核预留名额），无法继续创建审核面板。');
        }
    }

    const approvalChannel = await interaction.client.channels.fetch(approval.channelId);
    if (!approvalChannel) {
        throw new Error(`找不到配置的审核频道: ${approval.channelId}`);
    }

    // 1) 先创建 v2 申请记录并预留名额（默认 7 天过期释放）
    const createdAt = Date.now();
    const reservedUntil = createdAt + DEFAULT_PENDING_EXPIRE_MS;
    const applicationId = randomUUID();

    await saveSelfRoleApplicationV2(applicationId, {
        guildId: interaction.guild.id,
        applicantId: applicant.id,
        roleId: roleConfig.roleId,
        status: 'pending',
        reason: reasonText || null,
        reviewMessageId: null,
        reviewChannelId: null,
        slotReserved: true,
        reservedUntil,
        createdAt,
        resolvedAt: null,
        resolutionReason: null,
    });

    const pendingReservedNow = await countReservedPendingSelfRoleApplicationsV2(interaction.guild.id, roleConfig.roleId, Date.now());
    const maxText = hasLimit ? String(maxMembers) : '∞';
    const vacancyText = hasLimit
        ? String(Math.max(0, maxMembers - holders - pendingReservedNow))
        : '∞';

    const embed = new EmbedBuilder()
        .setTitle(`📜 身份组申请审核: ${roleConfig.label}`)
        .setDescription(`用户 **${applicant.tag}** (${applicant.id}) 申请获取 **${role.name}** 身份组，已通过资格预审，现进入社区投票审核阶段。`)
        .addFields(
            { name: '申请人', value: `<@${applicant.id}>`, inline: true },
            { name: '申请身份组', value: `<@&${role.id}>`, inline: true },
            { name: '状态', value: '🗳️ 投票中...', inline: true },
            { name: '现任/上限', value: `${holders} / ${maxText}`, inline: true },
            { name: '空缺', value: vacancyText, inline: true },
            { name: '待审核', value: String(pendingReservedNow), inline: true },
            { name: '支持票数', value: `0 / ${approval.requiredApprovals}`, inline: true },
            { name: '反对票数', value: `0 / ${approval.requiredRejections}`, inline: true }
        )
        .setColor(0xFEE75C) // Yellow
        .setTimestamp();

    const bundleRoleIds = Array.isArray(roleConfig.bundleRoleIds) ? roleConfig.bundleRoleIds : [];
    if (bundleRoleIds.length > 0) {
        const text = bundleRoleIds.map(rid => `<@&${rid}>`).join(' ');
        embed.addFields({ name: '配套身份组', value: text.length > 1024 ? text.slice(0, 1021) + '…' : text, inline: false });
    }

    if (reasonText && reasonText.trim().length > 0) {
        // 安全处理：去除零宽字符并截断，防止破坏dcapi功能
        const sanitized = (reasonText || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        embed.addFields({ name: '申请理由', value: sanitized.length > 1024 ? sanitized.slice(0, 1024) + '…' : sanitized, inline: false });
    }

    const approveButton = new ButtonBuilder()
        .setCustomId(`self_role_approve_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('✅ 支持')
        .setStyle(ButtonStyle.Success);

    const rejectButton = new ButtonBuilder()
        .setCustomId(`self_role_reject_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('❌ 反对')
        .setStyle(ButtonStyle.Danger);

    const rejectWithReasonButton = new ButtonBuilder()
        .setCustomId(`self_role_reason_reject_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('📝 反对并说明')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(approveButton, rejectButton, rejectWithReasonButton);

    // 根据频道类型发送：支持 文字频道/论坛/子区
    let panelMessageId = null;
    let panelChannelId = null;

    try {
        if (approvalChannel.type === ChannelType.GuildForum) {
            // 论坛频道：创建一个主题贴，首条消息就是投票面板
            const thread = await approvalChannel.threads.create({
                name: `身份组申请-${roleConfig.label}-${applicant.username}`,
                autoArchiveDuration: 10080, // 7天，按需调整
                message: {
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { parse: [] },
                },
            });
            const starter = await thread.fetchStarterMessage().catch(() => null);
            if (!starter) {
                throw new Error('无法获取论坛主题的首条消息以绑定投票面板ID');
            }
            panelMessageId = starter.id;
            panelChannelId = thread.id;
        } else {
            // 文字频道或线程：直接发送
            const sent = await approvalChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
            panelMessageId = sent.id;
            panelChannelId = approvalChannel.id;
        }

        // 2) 回填 v2 申请记录的审核消息定位
        await saveSelfRoleApplicationV2(applicationId, {
            guildId: interaction.guild.id,
            applicantId: applicant.id,
            roleId: roleConfig.roleId,
            status: 'pending',
            reason: reasonText || null,
            reviewMessageId: panelMessageId,
            reviewChannelId: panelChannelId,
            slotReserved: true,
            reservedUntil,
            createdAt,
            resolvedAt: null,
            resolutionReason: null,
        });

        // 在数据库中创建 legacy 申请记录（投票服务当前仍基于该表）
        await saveSelfRoleApplication(panelMessageId, {
            applicantId: applicant.id,
            roleId: roleConfig.roleId,
            status: 'pending',
            approvers: [],
            rejecters: [],
            rejectReasons: {},
            reason: reasonText || null,
        });

        // 3) 触发用户面板刷新（待审核数、空缺数变化）
        scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'application_created');

        console.log(`[SelfRole] ✅ 为 ${applicant.tag} 的 ${roleConfig.label} 申请创建了审核面板: ${panelMessageId}`);
    } catch (err) {
        // 失败兜底：释放预留名额，避免卡死
        await resolveSelfRoleApplicationV2(applicationId, 'failed', 'panel_create_failed', Date.now()).catch(() => {});

        if (panelMessageId) {
            // 若 message 已创建但后续落库失败，则清理 legacy 记录并尽量禁用按钮
            await deleteSelfRoleApplication(panelMessageId).catch(() => {});
            try {
                if (panelChannelId) {
                    const ch = await interaction.client.channels.fetch(panelChannelId).catch(() => null);
                    if (ch && ch.isTextBased()) {
                        const msg = await ch.messages.fetch(panelMessageId).catch(() => null);
                        if (msg) {
                            await msg.edit({ components: [] }).catch(() => {});
                        }
                    }
                }
            } catch (_) {}
        }

        scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'application_create_failed');
        throw err;
    }
}

/**
 * 处理“申请理由”窗口提交
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleReasonModalSubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const customId = interaction.customId; // self_role_reason_modal_<roleId>
    const roleId = customId.replace('self_role_reason_modal_', '');

    // 先做一次过期清理（避免“已过期但未清理”的 pending 卡住重复申请）
    await checkExpiredSelfRoleApplications(interaction.client).catch(() => {});

    // 读取当前配置与活动数据
    const settings = await getSelfRoleSettings(guildId);
    const roleConfig = settings?.roles?.find(r => r.roleId === roleId);
    if (!roleConfig) {
        await interaction.editReply({ content: '❌ 找不到该身份组的配置，可能已被管理员移除。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 资格预审（防绕过）：由于“理由 modal”可能在下拉菜单阶段被提前弹出，
    // 这里必须再次执行与 handleSelfRoleSelect 相同的资格校验。
    if (member?.roles?.cache?.has?.(roleId)) {
        await interaction.editReply({ content: `ℹ️ **${roleConfig.label}**: 你已拥有该身份组，无需重复申请。` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const conditions = roleConfig.conditions || {};
    const failureReasons = [];

    // 1) 前置身份组
    if (conditions.prerequisiteRoleId && !member.roles.cache.has(conditions.prerequisiteRoleId)) {
        const requiredRole = await interaction.guild.roles.fetch(conditions.prerequisiteRoleId).catch(() => null);
        const roleName = requiredRole?.name || conditions.prerequisiteRoleId;
        failureReasons.push(`需要拥有 **${roleName}** 身份组`);
    }

    // 2) 活跃度条件
    if (conditions.activity) {
        const userActivity = await getUserActivity(guildId);
        const { channelId, requiredMessages, requiredMentions, requiredMentioning, activeDaysThreshold } = conditions.activity;
        const activity = userActivity[channelId]?.[member.id] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => ({ id: channelId }));

        if (activity.messageCount < (requiredMessages || 0)) {
            failureReasons.push(`在 <#${channel.id}> 发言数需达到 **${requiredMessages || 0}** (当前: ${activity.messageCount})`);
        }
        if (activity.mentionedCount < (requiredMentions || 0)) {
            failureReasons.push(`在 <#${channel.id}> 被提及数需达到 **${requiredMentions || 0}** (当前: ${activity.mentionedCount})`);
        }
        if (activity.mentioningCount < (requiredMentioning || 0)) {
            failureReasons.push(`在 <#${channel.id}> 主动提及数需达到 **${requiredMentioning || 0}** (当前: ${activity.mentioningCount})`);
        }

        if (activeDaysThreshold) {
            const { dailyMessageThreshold, requiredActiveDays } = activeDaysThreshold;
            const actualActiveDays = await getUserActiveDaysCount(guildId, channelId, member.id, dailyMessageThreshold);
            if (actualActiveDays < requiredActiveDays) {
                failureReasons.push(`在 <#${channel.id}> 每日发言超过 **${dailyMessageThreshold}** 条的天数需达到 **${requiredActiveDays}** 天 (当前: ${actualActiveDays} 天)`);
            }
        }
    }

    if (failureReasons.length > 0) {
        await interaction.editReply({ content: `❌ **${roleConfig.label}**: 申请失败，原因：${failureReasons.join('； ')}` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 3) 名额检查（现任 + 待审核预留名额）
    const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
    const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
    if (hasLimit) {
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
            await interaction.editReply({ content: `❌ **${roleConfig.label}**: 无法获取身份组信息，可能已被删除或机器人权限不足。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
        const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
        const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, Date.now());
        if (holders + pendingReserved >= maxMembers) {
            await interaction.editReply({ content: `❌ **${roleConfig.label}**: 当前已满员（现任 ${holders}/${maxMembers}，待审核 ${pendingReserved}），暂无空缺，无法申请。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
    }

    // 再次防重复与冷却检查（避免并发/时序问题）
    if (roleConfig.conditions?.approval) {
        const existingV2 = await getPendingSelfRoleApplicationV2ByApplicantRole(guildId, member.id, roleId);
        const existingLegacy = await getPendingApplicationByApplicantRole(member.id, roleId);
        const existing = existingV2 || existingLegacy;
        if (existing) {
            const expireText = existingV2?.reservedUntil
                ? `（将于 ${formatDateTime(existingV2.reservedUntil)} 自动过期）`
                : '';
            await interaction.editReply({ content: `⏳ **${roleConfig.label}**: 您的申请已在人工审核中，请耐心等待${expireText}。如需撤回，请使用 /自助身份组申请-撤回申请。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
        const cooldown = await getSelfRoleCooldown(guildId, roleId, member.id);
        if (cooldown && cooldown.expiresAt > Date.now()) {
            const remainingMs = cooldown.expiresAt - Date.now();
            const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
            const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
            const parts = [];
            if (days > 0) parts.push(`${days}天`);
            if (hours > 0) parts.push(`${hours}小时`);
            if (minutes > 0) parts.push(`${minutes}分钟`);
            const remainText = parts.length > 0 ? parts.join('') : '不到1分钟';
            await interaction.editReply({ content: `❌ **${roleConfig.label}**: 冷却期未结束，还有 ${remainText}。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
    }

    // 读取并校验理由
    const inputRaw = interaction.fields.getTextInputValue('reason') || '';
    const reasonCfg = roleConfig?.conditions?.reason || {};
    let sanitized = inputRaw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/\s{2,}/g, ' ');

    const minLen = Number.isInteger(reasonCfg.minLen) ? reasonCfg.minLen : 10;
    const maxLen = Number.isInteger(reasonCfg.maxLen) ? reasonCfg.maxLen : 500;
    const mode = reasonCfg.mode || 'disabled';

    if (mode === 'required') {
        if (!sanitized || sanitized.length < minLen) {
            await interaction.editReply({ content: `❌ 申请理由长度不足，至少需 **${minLen}** 字符。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
    }
    if (sanitized.length > maxLen) {
        // 超限则截断到最大长度
        sanitized = sanitized.slice(0, maxLen);
    }

    // 继续流程：需审核 → 创建审核面板；无需审核 → 直接发身份
    try {
        if (roleConfig.conditions?.approval) {
            await createApprovalPanel(interaction, roleConfig, sanitized || null);
            await interaction.editReply({ content: `⏳ **${roleConfig.label}**: 资格审查通过，已提交社区审核。` });
        } else {
            // 直授场景：名额检查（现任 + 待审核预留名额）
            const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
            const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
            if (hasLimit) {
                const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (!role) {
                    await interaction.editReply({ content: `❌ **${roleConfig.label}**: 无法获取身份组信息，可能已被删除。` });
                    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                    return;
                }
                const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
                const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, Date.now());
                if (holders + pendingReserved >= maxMembers) {
                    await interaction.editReply({ content: `❌ **${roleConfig.label}**: 当前已满员（现任 ${holders}/${maxMembers}，待审核 ${pendingReserved}），暂无空缺，无法申请。` });
                    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                    return;
                }
            }

            // 直授场景：授予身份组
            const bundleRoleIds = Array.isArray(roleConfig.bundleRoleIds) ? roleConfig.bundleRoleIds : [];
            const roleIdsToAdd = [...new Set([roleId, ...bundleRoleIds])];
            await member.roles.add(roleIdsToAdd);

            try {
                await createSelfRoleGrant({
                    guildId,
                    userId: member.id,
                    primaryRoleId: roleId,
                    applicationId: null,
                    grantedAt: Date.now(),
                    bundleRoleIds,
                });
            } catch (dbErr) {
                console.error('[SelfRole] ❌ 写入 grant 记录失败（直授）:', dbErr);
            }

            const bundleSuffix = bundleRoleIds.length > 0 ? '（含配套身份组）' : '';
            await interaction.editReply({ content: `✅ **${roleConfig.label}**: 成功获取！${bundleSuffix}` });
            scheduleActiveUserSelfRolePanelsRefresh(interaction.client, guildId, 'direct_grant');
        }
    } catch (error) {
        console.error(`[SelfRole] ❌ 提交理由后继续流程时出错 for ${roleConfig.label}:`, error);
        await interaction.editReply({ content: `❌ **${roleConfig.label}**: 处理失败，请联系管理员。` });
    }

    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}