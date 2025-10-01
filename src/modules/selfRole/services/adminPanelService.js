// src/modules/selfRole/services/adminPanelService.js

const { ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSelfRoleSettings, saveSelfRoleSettings } = require('../../../core/utils/database');
const { updateMonitoredChannels } = require('./activityTracker');

const ROLES_PER_PAGE = 25;

/**
 * 处理管理员点击“添加身份组”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleAddRoleButton(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const allRoles = await interaction.guild.roles.fetch();
    const sortedRoles = allRoles.sort((a, b) => b.position - a.position);
    
    const settings = await getSelfRoleSettings(interaction.guild.id);
    const configuredRoleIds = settings ? settings.roles.map(r => r.roleId) : [];

    // 过滤掉 @everyone 和已被配置的身份组
    const availableRoles = sortedRoles.filter(role => role.name !== '@everyone' && !configuredRoleIds.includes(role.id));

    if (availableRoles.size === 0) {
        interaction.editReply({ content: '❌ 所有可用的身份组都已被配置。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const totalPages = Math.ceil(availableRoles.size / ROLES_PER_PAGE);
    const components = createPagedRoleSelectMenu(availableRoles, 1, totalPages, 'add');

    const reply = await interaction.editReply({
        content: '请选择一个要添加为可申请的身份组：',
        components: components,
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}

/**
 * 处理管理员在下拉菜单中选择要添加的身份组后的事件。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 字符串选择菜单交互对象。
 */
async function handleRoleSelectForAdd(interaction) {
    const roleId = interaction.values[0];
    const role = await interaction.guild.roles.fetch(roleId);

    const modal = new ModalBuilder()
        .setCustomId(`admin_add_role_modal_${roleId}`)
        .setTitle(`配置身份组: ${role.name}`);

    const labelInput = new TextInputBuilder()
        .setCustomId('label')
        .setLabel('显示名称 (必填)')
        .setStyle(TextInputStyle.Short)
        .setValue(role.name)
        .setRequired(true);

    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('描述 (可选)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    const prerequisiteInput = new TextInputBuilder()
        .setCustomId('prerequisiteRoleId')
        .setLabel('前置身份组ID (可选)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const activityInput = new TextInputBuilder()
        .setCustomId('activity')
        .setLabel('活跃度: 频道ID,发言数,被提及数,主动提及数,每日阈值,天数')
        .setPlaceholder('12345,100,,20,50,10 (频道,发言,被提及,主动提及,每日阈值,天数)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    const approvalInput = new TextInputBuilder()
        .setCustomId('approval')
        .setLabel('社区审核参数')
        .setPlaceholder('格式: 审核频道ID,支持票,反对票,审核员组ID(可多个,逗号分隔),被拒绝后冷却天数(可选)\n示例: 987654321098765432,10,5,111,222,3')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(labelInput),
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(prerequisiteInput),
        new ActionRowBuilder().addComponents(activityInput),
        new ActionRowBuilder().addComponents(approvalInput)
    );

    await interaction.showModal(modal);
}

/**
 * 处理管理员提交身份组配置模态框的事件（用于添加或修改）。
 * @param {import('discord.js').ModalSubmitInteraction} interaction - 模态框提交交互对象。
 */
async function handleModalSubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const isEdit = interaction.customId.startsWith('admin_edit_role_modal_');
    const roleId = interaction.customId.replace(isEdit ? 'admin_edit_role_modal_' : 'admin_add_role_modal_', '');
    const guildId = interaction.guild.id;

    try {
        const label = interaction.fields.getTextInputValue('label');
        const description = interaction.fields.getTextInputValue('description');
        const prerequisiteRoleId = interaction.fields.getTextInputValue('prerequisiteRoleId');
        const activityString = interaction.fields.getTextInputValue('activity');
        const approvalString = interaction.fields.getTextInputValue('approval');

        let settings = await getSelfRoleSettings(guildId) || { roles: [] };

        // 如果是添加操作，检查身份组是否已存在
        if (!isEdit && settings.roles.some(r => r.roleId === roleId)) {
            interaction.editReply({ content: `❌ 该身份组已被其他管理员配置。` });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }

        const newRoleConfig = {
            roleId,
            label,
            description,
            conditions: {},
        };

        // 解析并验证条件
        if (prerequisiteRoleId) {
            const role = await interaction.guild.roles.fetch(prerequisiteRoleId).catch(() => null);
            if (!role) {
                interaction.editReply({ content: `❌ 无效的前置身份组ID: ${prerequisiteRoleId}` });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }
            newRoleConfig.conditions.prerequisiteRoleId = prerequisiteRoleId;
        }

        if (activityString) {
            const parts = activityString.split(',').map(s => s.trim());
            const [channelId, messages, mentions, mentioning, dailyThreshold, requiredDays] = parts;

            const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                interaction.editReply({ content: `❌ 无效的活跃度频道ID: ${channelId}` });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            const requiredMessages = parseInt(messages) || 0;
            const requiredMentions = parseInt(mentions) || 0;
            const requiredMentioning = parseInt(mentioning) || 0;

            newRoleConfig.conditions.activity = {
                channelId,
                requiredMessages,
                requiredMentions,
                requiredMentioning,
            };

            // 处理活跃天数阈值配置 
            if (dailyThreshold && requiredDays) {
                const dailyMessageThreshold = parseInt(dailyThreshold);
                const requiredActiveDays = parseInt(requiredDays);

                if (isNaN(dailyMessageThreshold) || isNaN(requiredActiveDays) || dailyMessageThreshold <= 0 || requiredActiveDays <= 0) {
                    interaction.editReply({ content: `❌ 活跃天数配置格式错误，每日发言阈值和需要天数必须是正整数。` });
                    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                    return;
                }

                newRoleConfig.conditions.activity.activeDaysThreshold = {
                    dailyMessageThreshold,
                    requiredActiveDays,
                };
            }
        }

        if (approvalString) {
            // 支持“被拒绝后冷却天数”的解析：最后一个字段若为纯数字则视为冷却天数
            const tokens = approvalString.split(',').map(s => s.trim()).filter(Boolean);
            const channelId = tokens[0];
            const approvalsStr = tokens[1];
            const rejectionsStr = tokens[2];
            let voterRoleIds = tokens.slice(3);
            let cooldownDays = null;

            const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                interaction.editReply({ content: `❌ 无效的审核频道ID: ${channelId}` });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            if (isNaN(parseInt(approvalsStr)) || isNaN(parseInt(rejectionsStr))) {
                interaction.editReply({ content: `❌ 支持和反对票数必须是数字。` });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            // 如果最后一项是纯数字，则作为冷却天数
            if (voterRoleIds.length > 0) {
                const last = voterRoleIds[voterRoleIds.length - 1];
                if (/^\d+$/.test(last)) {
                    cooldownDays = parseInt(last);
                    voterRoleIds = voterRoleIds.slice(0, -1);
                }
            }

            // 校验投票人身份组ID（若有）
            for (const rId of voterRoleIds) {
                const role = await interaction.guild.roles.fetch(rId).catch(() => null);
                if (!role) {
                    interaction.editReply({ content: `❌ 无效的投票人身份组ID: ${rId}` });
                    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                    return;
                }
            }

            newRoleConfig.conditions.approval = {
                channelId,
                requiredApprovals: parseInt(approvalsStr),
                requiredRejections: parseInt(rejectionsStr),
                allowedVoterRoles: voterRoleIds,
            };
            if (typeof cooldownDays === 'number' && cooldownDays > 0) {
                newRoleConfig.conditions.approval.cooldownDays = cooldownDays;
            }
        }

        if (isEdit) {
            const roleIndex = settings.roles.findIndex(r => r.roleId === roleId);
            if (roleIndex > -1) {
                settings.roles[roleIndex] = newRoleConfig;
            } else {
                interaction.editReply({ content: '❌ 找不到要修改的身份组配置，可能已被移除。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }
        } else {
            settings.roles.push(newRoleConfig);
        }

        await saveSelfRoleSettings(guildId, settings);
        await updateMonitoredChannels(guildId); // 通知追踪器更新缓存

        const actionText = isEdit ? '修改' : '配置';
        await interaction.editReply({ content: `✅ 成功${actionText}了身份组 **${label}**！` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

    } catch (error) {
        console.error('[SelfRole] ❌ 处理模态窗口提交时出错:', error);
        await interaction.editReply({ content: '❌ 处理配置时发生错误。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 处理管理员点击“移除身份组”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleRemoveRoleButton(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const settings = await getSelfRoleSettings(interaction.guild.id);
    const configuredRoles = settings ? settings.roles : [];

    if (configuredRoles.length === 0) {
        interaction.editReply({ content: '❌ 当前没有配置任何可申请的身份组。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const totalPages = Math.ceil(configuredRoles.length / ROLES_PER_PAGE);
    const components = createPagedRoleSelectMenu(configuredRoles, 1, totalPages, 'remove');

    await interaction.editReply({
        content: '请选择一个要移除的身份组：',
        components: components,
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}

/**
 * 处理管理员在下拉菜单中选择要移除的身份组后的事件。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 字符串选择菜单交互对象。
 */
async function handleRoleSelectForRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const roleIdToRemove = interaction.values[0];
    const guildId = interaction.guild.id;

    try {
        let settings = await getSelfRoleSettings(guildId);
        const roleIndex = settings.roles.findIndex(r => r.roleId === roleIdToRemove);

        if (roleIndex === -1) {
            interaction.editReply({ content: '❌ 找不到要移除的身份组，可能已被其他管理员移除。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }
        
        const removedRoleLabel = settings.roles[roleIndex].label;
        settings.roles.splice(roleIndex, 1);
        await saveSelfRoleSettings(guildId, settings);
        await updateMonitoredChannels(guildId); // 通知追踪器更新缓存

        await interaction.editReply({ content: `✅ 成功移除了身份组 **${removedRoleLabel}**。` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

    } catch (error) {
        console.error('[SelfRole] ❌ 处理移除身份组时出错:', error);
        await interaction.editReply({ content: '❌ 处理移除时发生错误。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 处理管理员点击“列出身份组”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleListRolesButton(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const settings = await getSelfRoleSettings(interaction.guild.id);
    const configuredRoles = settings ? settings.roles : [];

    if (configuredRoles.length === 0) {
        interaction.editReply({ content: 'ℹ️ 当前没有配置任何可申请的身份组。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('可申请的身份组列表')
        .setColor('#0099ff')
        .setTimestamp();

    let description = '';
    for (const roleConfig of configuredRoles) {
        const role = await interaction.guild.roles.fetch(roleConfig.roleId).catch(() => null);
        description += `### ${roleConfig.label} (${role ? role.name : '未知身份组'})\n`;
        description += `**ID:** \`${roleConfig.roleId}\`\n`;
        if (roleConfig.description) {
            description += `**描述:** ${roleConfig.description}\n`;
        }
        
        const conditions = [];
        if (roleConfig.conditions.prerequisiteRoleId) {
            const preRole = await interaction.guild.roles.fetch(roleConfig.conditions.prerequisiteRoleId).catch(() => null);
            conditions.push(`- **前置身份组:** ${preRole ? preRole.name : '未知'}`);
        }
        if (roleConfig.conditions.activity) {
            const activity = roleConfig.conditions.activity;
            let activityConds = [];
            if (activity.requiredMessages > 0) activityConds.push(`发言 **${activity.requiredMessages}** 次`);
            if (activity.requiredMentions > 0) activityConds.push(`被提及 **${activity.requiredMentions}** 次`);
            if (activity.requiredMentioning > 0) activityConds.push(`主动提及 **${activity.requiredMentioning}** 次`);

            if (activityConds.length > 0) {
                conditions.push(`- **活跃度:** 在 <#${activity.channelId}> 中${activityConds.join(', ')}`);
            }

            // 显示活跃天数阈值条件 
            if (activity.activeDaysThreshold) {
                const { dailyMessageThreshold, requiredActiveDays } = activity.activeDaysThreshold;
                conditions.push(`- **活跃天数:** 在 <#${activity.channelId}> 中每日发言超过 **${dailyMessageThreshold}** 条的天数需达到 **${requiredActiveDays}** 天`);
            }
        }
        if (roleConfig.conditions.approval) {
            const approval = roleConfig.conditions.approval;
            let line = `- **社区审核:** 在 <#${approval.channelId}> 中投票 (需 ${approval.requiredApprovals} 支持 / ${approval.requiredRejections} 反对)`;
            if (approval.cooldownDays && approval.cooldownDays > 0) {
                line += `；被拒后冷却 **${approval.cooldownDays}** 天`;
            }
            conditions.push(line);
        }

        if (conditions.length > 0) {
            description += `**申请条件:**\n${conditions.join('\n')}\n`;
        } else {
            description += `**申请条件:** 无\n`;
        }
        description += '---\n';
    }
    
    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}


/**
 * 创建一个带有分页功能的身份组选择菜单。
 * @param {Collection<string, import('discord.js').Role> | Array<object>} roles - Discord 身份组集合或身份组配置数组。
 * @param {number} page - 当前页码。
 * @param {number} totalPages - 总页数。
 * @param {string} type - 菜单类型，'add'、'remove' 或 'edit'。
 * @returns {Array<ActionRowBuilder>} - 包含选择菜单和分页按钮的组件数组。
 */
function createPagedRoleSelectMenu(roles, page, totalPages, type) {
    const roleArray = Array.from(roles.values());
    const startIndex = (page - 1) * ROLES_PER_PAGE;
    const pageRoles = roleArray.slice(startIndex, startIndex + ROLES_PER_PAGE);

    const options = pageRoles.map(role => ({
        label: type === 'add' ? role.name : role.label,
        description: `ID: ${type === 'add' ? role.id : role.roleId}`,
        value: type === 'add' ? role.id : role.roleId,
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`admin_${type}_role_select`)
        .setPlaceholder(`请选择身份组 (第 ${page}/${totalPages} 页)...`)
        .addOptions(options.length > 0 ? options : [{ label: '此页无选项', value: 'no_options', default: true }]);

    const menuRow = new ActionRowBuilder().addComponents(selectMenu);
    
    const components = [menuRow];

    if (totalPages > 1) {
        const prevButton = new ButtonBuilder()
            .setCustomId(`admin_roles_page_${type}_${page - 1}`)
            .setLabel('上一页')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 1);

        const nextButton = new ButtonBuilder()
            .setCustomId(`admin_roles_page_${type}_${page + 1}`)
            .setLabel('下一页')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === totalPages);
        
        const buttonRow = new ActionRowBuilder().addComponents(prevButton, nextButton);
        components.push(buttonRow);
    }

    return components;
}

/**
 * 处理身份组选择菜单的分页按钮点击事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleRoleListPageChange(interaction) {
    await interaction.deferUpdate();
    const [,,, type, pageStr] = interaction.customId.split('_');
    const page = parseInt(pageStr);

    let roles;
    if (type === 'add') {
        const allRoles = await interaction.guild.roles.fetch();
        const sortedRoles = allRoles.sort((a, b) => b.position - a.position);
        const settings = await getSelfRoleSettings(interaction.guild.id);
        const configuredRoleIds = settings ? settings.roles.map(r => r.roleId) : [];
        roles = sortedRoles.filter(role => role.name !== '@everyone' && !configuredRoleIds.includes(role.id));
    } else { // 'remove' or 'edit'
        const settings = await getSelfRoleSettings(interaction.guild.id);
        roles = settings ? settings.roles : [];
    }
    
    const rolesData = type === 'add' ? roles : roles;
    const totalPages = Math.ceil((type === 'add' ? rolesData.size : rolesData.length) / ROLES_PER_PAGE);
    
    const components = createPagedRoleSelectMenu(rolesData, page, totalPages, type);

    await interaction.editReply({ components });
}


/**
 * 处理管理员点击“修改配置”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleEditRoleButton(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const settings = await getSelfRoleSettings(interaction.guild.id);
    const configuredRoles = settings ? settings.roles : [];

    if (configuredRoles.length === 0) {
        interaction.editReply({ content: '❌ 当前没有配置任何可申请的身份组。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const totalPages = Math.ceil(configuredRoles.length / ROLES_PER_PAGE);
    const components = createPagedRoleSelectMenu(configuredRoles, 1, totalPages, 'edit');

    await interaction.editReply({
        content: '请选择一个要修改配置的身份组：',
        components: components,
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
}

/**
 * 处理管理员在下拉菜单中选择要修改的身份组后的事件。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 字符串选择菜单交互对象。
 */
async function handleRoleSelectForEdit(interaction) {
    const roleId = interaction.values[0];
    const settings = await getSelfRoleSettings(interaction.guild.id);
    const roleConfig = settings.roles.find(r => r.roleId === roleId);

    if (!roleConfig) {
        interaction.reply({ content: '❌ 找不到该身份组的配置。', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const role = await interaction.guild.roles.fetch(roleId);

    const modal = new ModalBuilder()
        .setCustomId(`admin_edit_role_modal_${roleId}`)
        .setTitle(`修改配置: ${role.name}`);

    // 使用现有配置预填充字段
    const labelInput = new TextInputBuilder().setCustomId('label').setLabel('显示名称 (必填)').setStyle(TextInputStyle.Short).setValue(roleConfig.label).setRequired(true);
    const descriptionInput = new TextInputBuilder().setCustomId('description').setLabel('描述 (可选)').setStyle(TextInputStyle.Paragraph).setValue(roleConfig.description || '').setRequired(false);
    const prerequisiteInput = new TextInputBuilder().setCustomId('prerequisiteRoleId').setLabel('前置身份组ID (可选)').setStyle(TextInputStyle.Short).setValue(roleConfig.conditions.prerequisiteRoleId || '').setRequired(false);
    
    let activityValue = '';
    if (roleConfig.conditions.activity) {
        const a = roleConfig.conditions.activity;
        activityValue = `${a.channelId},${a.requiredMessages},${a.requiredMentions},${a.requiredMentioning}`;

        // 如果有活跃天数阈值配置，也加入到值中
        if (a.activeDaysThreshold) {
            activityValue += `,${a.activeDaysThreshold.dailyMessageThreshold},${a.activeDaysThreshold.requiredActiveDays}`;
        }
    }
    const activityInput = new TextInputBuilder().setCustomId('activity').setLabel('活跃度: 频道ID,发言数,被提及数,主动提及数,每日阈值,天数').setPlaceholder('12345,100,,20,50,10 (频道,发言,被提及,主动提及,每日阈值,天数)').setStyle(TextInputStyle.Paragraph).setValue(activityValue).setRequired(false);

    let approvalValue = '';
    if (roleConfig.conditions.approval) {
        const ap = roleConfig.conditions.approval;
        const tokens = [ap.channelId, ap.requiredApprovals, ap.requiredRejections];
        if (ap.allowedVoterRoles && ap.allowedVoterRoles.length > 0) {
            tokens.push(...ap.allowedVoterRoles);
        }
        if (ap.cooldownDays && ap.cooldownDays > 0) {
            tokens.push(ap.cooldownDays);
        }
        approvalValue = tokens.join(',');
    }
    const approvalInput = new TextInputBuilder()
        .setCustomId('approval')
        .setLabel('社区审核参数')
        .setPlaceholder('格式: 审核频道ID,支持票,反对票,审核员组ID(可多个,逗号分隔),被拒绝后冷却天数(可选)\n示例: 987654321,10,5,111,222,3')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(approvalValue)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(labelInput),
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(prerequisiteInput),
        new ActionRowBuilder().addComponents(activityInput),
        new ActionRowBuilder().addComponents(approvalInput)
    );

    await interaction.showModal(modal);
}


module.exports = {
    handleAddRoleButton,
    handleRemoveRoleButton,
    handleEditRoleButton,
    handleListRolesButton,
    handleRoleSelectForAdd,
    handleRoleSelectForEdit,
    handleModalSubmit,
    handleRoleSelectForRemove,
    handleRoleListPageChange,
};