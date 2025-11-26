// src/modules/selfRole/services/selfRoleService.js

const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const { getSelfRoleSettings, getUserActivity, getUserActiveDaysCount, saveSelfRoleApplication, getPendingApplicationByApplicantRole, getSelfRoleCooldown } = require('../../../core/utils/database');

/**
 * 处理用户点击“自助身份组申请”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
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
    // 写的时候发现的问题，先留在这：若即将打开模态表单，不要先 deferReply，否则 showModal 会报 InteractionAlreadyReplied

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
            // 如果资格预审通过，检查是否需要审核
            if (conditions.approval) {
                // 1) 防重复逻辑：检查是否已存在“待审核”的同一用户对同一身份组申请
                const existing = await getPendingApplicationByApplicantRole(member.id, roleId);
                if (existing) {
                    // 已存在待审核面板，提醒用户耐心等待
                    results.push(`⏳ **${roleConfig.label}**: 您的身份组申请正在人工审核阶段，请耐心等候。`);
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
                        // 3) 不在冷却期且不存在待审核记录，若配置了理由则弹出模态，否则直接创建审核面板
                        const reasonCfg = roleConfig?.conditions?.reason;
                        if (reasonCfg && reasonCfg.mode && reasonCfg.mode !== 'disabled') {
                            try {
                                const modal = new ModalBuilder()
                                    .setCustomId(`self_role_reason_modal_${roleId}`)
                                    .setTitle(`申请理由: ${roleConfig.label}`);
                                const reasonInput = new TextInputBuilder()
                                    .setCustomId('reason')
                                    .setLabel('申请理由')
                                    .setStyle(TextInputStyle.Paragraph)
                                    .setPlaceholder('请详细说明申请该身份组的理由（示例：我在该频道的贡献、参与情况等）')
                                    .setRequired(reasonCfg.mode === 'required');
                                const modalRow = new ActionRowBuilder().addComponents(reasonInput);
                                modal.addComponents(modalRow);
                                await interaction.showModal(modal);
                                return;
                            } catch (error) {
                                console.error(`[SelfRole] ❌ 打开理由填写模态时出错 for ${roleConfig.label}:`, error);
                                results.push(`❌ **${roleConfig.label}**: 无法打开理由填写窗口，请联系管理员。`);
                            }
                        } else {
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
            }
            // 如果资格预审通过且无需审核
            else {
                const reasonCfg = roleConfig?.conditions?.reason;
                if (reasonCfg && reasonCfg.mode && reasonCfg.mode !== 'disabled') {
                    // 直授场景依然采集理由，但不公开展示（仅用于审计/后续扩展）
                    try {
                        const modal = new ModalBuilder()
                            .setCustomId(`self_role_reason_modal_${roleId}`)
                            .setTitle(`申请理由: ${roleConfig.label}`);
                        const reasonInput = new TextInputBuilder()
                            .setCustomId('reason')
                            .setLabel('申请理由')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder('请说明申请该身份组的理由（可选）')
                            .setRequired(reasonCfg.mode === 'required');
                        const modalRow = new ActionRowBuilder().addComponents(reasonInput);
                        modal.addComponents(modalRow);
                        await interaction.showModal(modal);
                        return;
                    } catch (error) {
                        console.error(`[SelfRole] ❌ 打开理由填写模态时出错 for ${roleConfig.label}:`, error);
                        results.push(`❌ **${roleConfig.label}**: 无法打开理由填写窗口，请联系管理员。`);
                    }
                } else {
                    try {
                        await member.roles.add(roleId);
                        results.push(`✅ **${roleConfig.label}**: 成功获取！`);
                    } catch (error) {
                        console.error(`[SelfRole] ❌ 授予身份组 ${roleConfig.label} 时出错:`, error);
                        results.push(`❌ **${roleConfig.label}**: 授予失败，可能是机器人权限不足。`);
                    }
                }
            }
        } else {
            // 如果资格预审不通过
            results.push(`❌ **${roleConfig.label}**: 申请失败，原因：${failureReasons.join('； ')}`);
        }
    }

    await interaction.reply({
        content: `**身份组申请结果:**\n\n${results.join('\n')}`,
        ephemeral: true,
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

    const approvalChannel = await interaction.client.channels.fetch(approval.channelId);
    if (!approvalChannel) {
        throw new Error(`找不到配置的审核频道: ${approval.channelId}`);
    }

    const embed = new EmbedBuilder()
        .setTitle(`📜 身份组申请审核: ${roleConfig.label}`)
        .setDescription(`用户 **${applicant.tag}** (${applicant.id}) 申请获取 **${role.name}** 身份组，已通过资格预审，现进入社区投票审核阶段。`)
        .addFields(
            { name: '申请人', value: `<@${applicant.id}>`, inline: true },
            { name: '申请身份组', value: `<@&${role.id}>`, inline: true },
            { name: '状态', value: '🗳️ 投票中...', inline: true },
            { name: '支持票数', value: `0 / ${approval.requiredApprovals}`, inline: true },
            { name: '反对票数', value: `0 / ${approval.requiredRejections}`, inline: true }
        )
        .setColor(0xFEE75C) // Yellow
        .setTimestamp();

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

    const row = new ActionRowBuilder().addComponents(approveButton, rejectButton);

    // 根据频道类型发送：支持 文字频道/论坛/子区
    let panelMessageId = null;
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
    } else {
        // 文字频道或线程：直接发送
        const sent = await approvalChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
        panelMessageId = sent.id;
    }
    
    // 在数据库中创建申请记录（带理由）
    await saveSelfRoleApplication(panelMessageId, {
        applicantId: applicant.id,
        roleId: roleConfig.roleId,
        status: 'pending',
        approvers: [],
        rejecters: [],
        reason: reasonText || null,
    });
    
    console.log(`[SelfRole] ✅ 为 ${applicant.tag} 的 ${roleConfig.label} 申请创建了审核面板: ${panelMessageId}`);
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

    // 读取当前配置与活动数据
    const settings = await getSelfRoleSettings(guildId);
    const roleConfig = settings?.roles?.find(r => r.roleId === roleId);
    if (!roleConfig) {
        await interaction.editReply({ content: '❌ 找不到该身份组的配置，可能已被管理员移除。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 再次防重复与冷却检查（避免并发/时序问题）
    if (roleConfig.conditions?.approval) {
        const existing = await getPendingApplicationByApplicantRole(member.id, roleId);
        if (existing) {
            await interaction.editReply({ content: `⏳ **${roleConfig.label}**: 您的申请已在人工审核中，请耐心等待。` });
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
            // 直授场景：授予身份组
            await member.roles.add(roleId);
            await interaction.editReply({ content: `✅ **${roleConfig.label}**: 成功获取！` });
        }
    } catch (error) {
        console.error(`[SelfRole] ❌ 提交理由后继续流程时出错 for ${roleConfig.label}:`, error);
        await interaction.editReply({ content: `❌ **${roleConfig.label}**: 处理失败，请联系管理员。` });
    }

    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}