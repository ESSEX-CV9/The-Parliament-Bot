// src/modules/contest/services/participantRoleService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const {
    getContestChannel,
    updateContestChannel,
    getSubmissionsByChannel
} = require('../utils/contestDatabase');
const { preprocessSubmissions, paginateData } = require('../utils/dataProcessor');
const { isRoleDecorative } = require('../utils/contestPermissions');

const ITEMS_PER_PAGE = 10; // 身份组管理面板中每页显示的用户数

/**
 * 绑定参赛者身份组到比赛
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Role} role
 */
async function bindParticipantRole(interaction, role) {
    const contestChannelData = await getContestChannel(interaction.channel.id);

    // 1. 检查身份组是否为纯装饰性
    if (!isRoleDecorative(role)) {
        return interaction.editReply({
            content: `❌ **身份组权限错误**\n\n身份组 \`${role.name}\` 包含权限，不能用作参赛者装饰身份组。\n\n请选择一个**没有任何权限**的身份组以确保安全。`
        });
    }

    // 2. 检查机器人身份组层级
    if (interaction.guild.members.me.roles.highest.position <= role.position) {
        return interaction.editReply({
            content: `❌ **身份组层级错误**\n\n我的身份组层级低于或等于 \`${role.name}\`，无法管理此身份组。\n\n请在服务器设置中将我的身份组拖到 \`${role.name}\` 之上。`
        });
    }

    // 3. 更新数据库
    await updateContestChannel(interaction.channel.id, {
        participantRoleId: role.id,
        autoGrantRole: contestChannelData.autoGrantRole || false // 保留现有的自动发放设置
    });

    await interaction.editReply({
        content: `✅ **绑定成功！**\n\n已将身份组 **${role}** 绑定到本次比赛。\n\n现在您可以使用 \`/管理比赛身份组\` 命令来管理身份组的发放。`
    });
}

/**
 * 打开身份组管理面板
 * @param {import('discord.js').Interaction} interaction
 */
async function openRoleManagementPanel(interaction) {
    const contestChannelData = await getContestChannel(interaction.channel.id);

    if (!contestChannelData || !contestChannelData.participantRoleId) {
        return interaction.editReply({
            content: '❌ 此比赛尚未绑定参赛者身份组。请先使用 `/绑定比赛身份组` 命令进行绑定。'
        });
    }

    const role = await interaction.guild.roles.fetch(contestChannelData.participantRoleId).catch(() => null);
    if (!role) {
        return interaction.editReply({
            content: '❌ 绑定的身份组似乎已被删除，请重新绑定一个新的身份组。'
        });
    }

    const { embed, components } = buildManagementPanel(contestChannelData, role);
    await interaction.editReply({ embeds: [embed], components: components });
}

/**
 * 构建管理面板
 * @param {object} contestChannelData
 * @param {import('discord.js').Role} role
 */
function buildManagementPanel(contestChannelData, role) {
    const autoGrantEnabled = contestChannelData.autoGrantRole || false;

    const embed = new EmbedBuilder()
        .setTitle('🏆 参赛者身份组管理面板')
        .setDescription(`管理比赛的专属身份组的发放和移除。\n\n**当前绑定身份组：** ${role} (\`${role.id}\`)`)
        .setColor(autoGrantEnabled ? '#4CAF50' : '#F44336')
        .addFields({
            name: '自动发放模式',
            value: autoGrantEnabled ? '🟢 **已启用** (新投稿者将自动获得身份组)' : '🔴 **已禁用** (需要手动发放)',
        })
        .setFooter({ text: '请使用下方按钮进行操作' });

    const components = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`role_manage_grant_list_${role.id}`)
                .setLabel('手动发放')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`role_manage_revoke_list_${role.id}`)
                .setLabel('手动移除')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`role_manage_toggle_auto_${role.id}`)
                .setLabel(autoGrantEnabled ? '禁用自动发放' : '启用自动发放')
                .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`role_manage_grant_all_${role.id}`)
                .setLabel('发放给所有参赛者')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`role_manage_list_all_${role.id}`)
                .setLabel('公开所有参赛者名单')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
    return { embed, components };
}

/**
 * 切换自动发放模式
 * @param {import('discord.js').Interaction} interaction
 */
async function toggleAutoGrant(interaction) {
    await interaction.deferUpdate();
    const contestChannelData = await getContestChannel(interaction.channel.id);
    const role = await interaction.guild.roles.fetch(contestChannelData.participantRoleId);

    const newAutoGrantState = !contestChannelData.autoGrantRole;
    await updateContestChannel(interaction.channel.id, { autoGrantRole: newAutoGrantState });

    // 重新获取数据以构建新面板
    const updatedData = await getContestChannel(interaction.channel.id);
    const { embed, components } = buildManagementPanel(updatedData, role);
    await interaction.editReply({ embeds: [embed], components: components });
}

/**
 * 获取所有参赛者成员对象
 * @param {import('discord.js').Guild} guild
 * @param {string} contestChannelId
 * @returns {Promise<Array<import('discord.js').GuildMember>>}
 */
async function getParticipantMembers(guild, contestChannelId) {
    const submissions = await getSubmissionsByChannel(contestChannelId);
    if (!submissions || submissions.length === 0) return [];

    const validSubmissions = preprocessSubmissions(submissions);
    const submitterIds = [...new Set(validSubmissions.map(s => s.submitterId))];

    const members = [];
    for (const id of submitterIds) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) members.push(member);
    }
    return members;
}

/**
 * 显示用户列表用于手动操作（发放/移除）
 * @param {import('discord.js').Interaction} interaction
 * @param {'grant'|'revoke'} mode
 */
async function showUserList(interaction, mode) {
    await interaction.deferReply({ ephemeral: true });

    const contestChannelData = await getContestChannel(interaction.channel.id);
    const role = await interaction.guild.roles.fetch(contestChannelData.participantRoleId);

    const allParticipants = await getParticipantMembers(interaction.guild, interaction.channel.id);
    if (allParticipants.length === 0) {
        return interaction.editReply({ content: '🤔 没有任何有效的参赛者。' });
    }

    let targetUsers;
    if (mode === 'grant') {
        targetUsers = allParticipants.filter(m => !m.roles.cache.has(role.id));
    } else { // revoke
        targetUsers = allParticipants.filter(m => m.roles.cache.has(role.id));
    }

    if (targetUsers.length === 0) {
        const message = mode === 'grant'
            ? '✅ 所有参赛者都已拥有该身份组。'
            : '✅ 没有任何参赛者拥有该身份组。';
        return interaction.editReply({ content: message });
    }

    // 分页处理
    const pagination = paginateData(targetUsers, 1, ITEMS_PER_PAGE);
    const { embed, components } = buildUserListPage(pagination, role, mode);

    await interaction.editReply({ embeds: [embed], components: components });
}

/**
 * 构建用户列表分页视图
 * @param {object} pagination
 * @param {import('discord.js').Role} role
 * @param {'grant'|'revoke'} mode
 */
function buildUserListPage(pagination, role, mode) {
    const { pageData, currentPage, totalPages } = pagination;
    const title = mode === 'grant' ? '手动发放身份组' : '手动移除身份组';

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(pageData.map((member, i) => `${((currentPage-1)*ITEMS_PER_PAGE)+i+1}. ${member.user.tag} (${member.id})`).join('\n'))
        .setColor(mode === 'grant' ? ButtonStyle.Success : ButtonStyle.Danger)
        .setFooter({ text: `第 ${currentPage} / ${totalPages} 页` });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`role_select_users_${mode}_${role.id}`)
        .setPlaceholder('选择要操作的用户...')
        .setMinValues(1)
        .setMaxValues(Math.min(pageData.length, 25))
        .addOptions(pageData.map(member => ({
            label: member.user.tag.substring(0, 100),
            value: member.id
        })));

    const components = [
        new ActionRowBuilder().addComponents(selectMenu),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`role_page_prev_${mode}_${role.id}_${currentPage}`).setLabel('◀️ 上一页').setStyle(ButtonStyle.Primary).setDisabled(currentPage <= 1),
            new ButtonBuilder().setCustomId(`role_page_next_${mode}_${role.id}_${currentPage}`).setLabel('下一页 ▶️').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`role_confirm_${mode}_${role.id}`).setLabel(mode === 'grant' ? '确认发放' : '确认移除').setStyle(mode === 'grant' ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('role_cancel_op').setLabel('取消').setStyle(ButtonStyle.Secondary)
        )
    ];

    return { embed, components };
}

/**
 * 处理用户列表分页
 * @param {import('discord.js').Interaction} interaction
 * @param {'grant'|'revoke'} mode
 */
async function handleUserListPageNavigation(interaction, mode) {
    await interaction.deferUpdate();
    const parts = interaction.customId.split('_');
    const roleId = parts[parts.length - 2];
    const currentPage = parseInt(parts[parts.length - 1]);
    const direction = parts[2]; // prev or next

    const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;

    const role = await interaction.guild.roles.fetch(roleId);
    const allParticipants = await getParticipantMembers(interaction.guild, interaction.channel.id);

    let targetUsers;
    if (mode === 'grant') {
        targetUsers = allParticipants.filter(m => !m.roles.cache.has(role.id));
    } else {
        targetUsers = allParticipants.filter(m => m.roles.cache.has(role.id));
    }

    const pagination = paginateData(targetUsers, newPage, ITEMS_PER_PAGE);
    const { embed, components } = buildUserListPage(pagination, role, mode);
    await interaction.editReply({ embeds: [embed], components: components });
}

/**
 * 确认手动操作（发放/移除）
 * @param {import('discord.js').Interaction} interaction
 * @param {'grant'|'revoke'} mode
 */
async function confirmManualAction(interaction, mode) {
    await interaction.deferUpdate();
    const roleId = interaction.customId.split('_').pop();
    const role = await interaction.guild.roles.fetch(roleId);

    // 从前一个交互（SelectMenu）中获取选择的用户
    const message = interaction.message;
    const selectInteraction = await message.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id && i.isStringSelectMenu(),
        componentType: ComponentType.StringSelect,
        time: 60000 // 60秒超时
    }).catch(() => null);

    if (!selectInteraction) {
        return interaction.followUp({ content: '❌ 操作超时，请重新选择用户。', ephemeral: true });
    }

    const userIds = selectInteraction.values;
    await selectInteraction.deferUpdate();

    let successCount = 0;
    let failCount = 0;

    for (const userId of userIds) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
            try {
                if (mode === 'grant') {
                    await member.roles.add(role);
                } else {
                    await member.roles.remove(role);
                }
                successCount++;
            } catch (e) {
                console.error(`Failed to ${mode} role for ${member.user.tag}:`, e);
                failCount++;
            }
        } else {
            failCount++;
        }
    }

    const actionText = mode === 'grant' ? '发放' : '移除';
    await interaction.editReply({
        content: `✅ **操作完成**\n成功${actionText} **${successCount}** 名用户。\n失败 **${failCount}** 名用户。`,
        embeds: [],
        components: []
    });
}


/**
 * 发放身份组给所有未拥有的参赛者
 * @param {import('discord.js').Interaction} interaction
 */
async function grantToAll(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const contestChannelData = await getContestChannel(interaction.channel.id);
    const role = await interaction.guild.roles.fetch(contestChannelData.participantRoleId);

    const allParticipants = await getParticipantMembers(interaction.guild, interaction.channel.id);
    const usersToGrant = allParticipants.filter(m => !m.roles.cache.has(role.id));

    if (usersToGrant.length === 0) {
        return interaction.editReply({ content: '✅ 所有参赛者都已拥有该身份组。' });
    }

    let successCount = 0;
    let failCount = 0;
    for (const member of usersToGrant) {
        try {
            await member.roles.add(role);
            successCount++;
        } catch (e) {
            failCount++;
        }
    }

    await interaction.editReply({
        content: `✅ **批量发放完成**\n成功发放给 **${successCount}** 名用户。\n失败 **${failCount}** 名用户。`
    });
}

/**
 * 私密地列出所有参赛者名单
 * @param {import('discord.js').Interaction} interaction
 */
async function listAllParticipants(interaction) {
    //  deferReply 必须是 ephemeral
    await interaction.deferReply({ ephemeral: true });

    const allParticipants = await getParticipantMembers(interaction.guild, interaction.channel.id);
    if (allParticipants.length === 0) {
        return interaction.editReply({ content: '🤔 没有任何有效的参赛者。' });
    }

    // 生成包含用户tag、ID和提及的详细列表
    const userListString = allParticipants
        .map((member, index) => `${index + 1}. ${member.user.tag} (${member.id})`)
        .join('\n');

    // 检查列表字符串长度
    // Discord Embed description 上限是 4096，私密消息内容上限是 2000，我们取一个保守值
    if (userListString.length < 1900) {
        // 如果名单不长，直接用 Embed 发送
        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${interaction.channel.name} - 参赛者名单 (私密)`)
            .setDescription(userListString)
            .setColor('#87CEEB')
            .setFooter({ text: `共 ${allParticipants.length} 人 | 此消息仅您可见` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } else {
        // 如果名单太长，生成一个 txt 文件发送
        const fileBuffer = Buffer.from(userListString, 'utf-8');
        const attachment = {
            attachment: fileBuffer,
            name: `participants-${interaction.channel.id}.txt`
        };

        await interaction.editReply({
            content: `✅ 参赛者名单过长（共 ${allParticipants.length} 人），已为您生成文本文件。此消息仅您可见。`,
            files: [attachment]
        });
    }
}


/**
 * 在投稿时自动发放身份组（如果已启用）
 * @param {import('discord.js').GuildMember} member - 投稿者成员对象
 * @param {string} contestChannelId - 比赛频道ID
 */
async function grantRoleOnSubmission(member, contestChannelId) {
    try {
        const contestChannelData = await getContestChannel(contestChannelId);
        if (!contestChannelData || !contestChannelData.autoGrantRole || !contestChannelData.participantRoleId) {
            return; // 未开启或未设置，直接返回
        }

        const role = await member.guild.roles.fetch(contestChannelData.participantRoleId).catch(() => null);
        if (!role || member.roles.cache.has(role.id)) {
            return; // 身份组不存在或用户已拥有，直接返回
        }

        if (!isRoleDecorative(role) || member.guild.members.me.roles.highest.position <= role.position) {
            console.warn(`[AutoGrant] Skipped granting role ${role.name} due to permission or hierarchy issues.`);
            return; // 安全检查失败
        }

        await member.roles.add(role);
        console.log(`[AutoGrant] Successfully granted role ${role.name} to ${member.user.tag}.`);
    } catch (error) {
        console.error(`[AutoGrant] Failed to grant role for contest ${contestChannelId} to ${member.user.tag}:`, error);
    }
}


module.exports = {
    bindParticipantRole,
    openRoleManagementPanel,
    toggleAutoGrant,
    showUserList,
    handleUserListPageNavigation,
    confirmManualAction,
    grantToAll,
    listAllParticipants,
    grantRoleOnSubmission
};