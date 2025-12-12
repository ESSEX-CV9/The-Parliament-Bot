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
                .setCustomId(`role_manage_bulk_grant_guide_${role.id}`) // 更改 customId
                .setLabel('批量发放指南') // 更改标签
                .setStyle(ButtonStyle.Primary), // 样式可以保持 Primary 或改为 Secondary
            new ButtonBuilder()
                .setCustomId(`role_manage_list_all_${role.id}`)
                .setLabel('导出参赛者名单')
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
 * 启动用户列表交互会话 (All-in-One 解决方案)
 * 这模仿了 discord.py 的 View 逻辑，在一个函数内处理所有后续交互
 * @param {import('discord.js').Interaction} interaction
 * @param {'grant'|'revoke'} mode
 */
async function showUserList(interaction, mode) {
    // 1. 初始准备
    // 如果是按钮触发的，需要先 deferReply；如果是翻页等内部调用，可能需要根据情况处理
    // 这里假设是从管理面板按钮点击进来的
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const contestChannelData = await getContestChannel(interaction.channel.id);
    const role = await interaction.guild.roles.fetch(contestChannelData.participantRoleId).catch(() => null);

    if (!role) {
        return interaction.editReply({ content: '❌ 找不到绑定的身份组。' });
    }

    // 2. 获取数据
    const allParticipants = await getParticipantMembers(interaction.guild, interaction.channel.id);
    let targetUsers = [];
    if (mode === 'grant') {
        targetUsers = allParticipants.filter(m => !m.roles.cache.has(role.id));
    } else {
        targetUsers = allParticipants.filter(m => m.roles.cache.has(role.id));
    }

    if (targetUsers.length === 0) {
        return interaction.editReply({ content: mode === 'grant' ? '✅ 所有人都已有该身份组。' : '✅ 没人有该身份组。' });
    }

    // --- 状态管理 (局部变量，类似 Py 的 self.value) ---
    let currentPage = 1;
    let selectedUserIds = new Set(); // 使用 Set 防止重复选择
    const ITEMS_PER_PAGE = 25; // SelectMenu 最大支持25个

    // 3. 渲染页面函数
    const renderPage = async (i = null) => {
        const pagination = paginateData(targetUsers, currentPage, ITEMS_PER_PAGE);
        const { pageData, totalPages } = pagination;

        const title = mode === 'grant' ? '手动发放身份组' : '手动移除身份组';

        // 构建描述：标记出哪些已经被选中了
        const description = pageData.map((member, index) => {
            const isSelected = selectedUserIds.has(member.id);
            const mark = isSelected ? '✅ ' : '';
            return `${mark}${((currentPage - 1) * ITEMS_PER_PAGE) + index + 1}. ${member.user.tag}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description || '本页无数据')
            .setColor(mode === 'grant' ? '#57F287' : '#ED4245')
            .setFooter({ text: `已选择: ${selectedUserIds.size} 人 | 第 ${currentPage} / ${totalPages} 页` });

        // 构建 Select Menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('temp_select_users') // ID不重要了，因为我们用Collector
            .setPlaceholder('在本页选择用户 (可多选)...')
            .setMinValues(1)
            .setMaxValues(pageData.length);

        const options = pageData.map(member => ({
            label: member.user.tag.substring(0, 100),
            value: member.id,
            default: selectedUserIds.has(member.id) // 关键：回显选中状态
        }));

        selectMenu.setOptions(options);

        // 构建按钮
        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_prev').setLabel('◀️ 上一页').setStyle(ButtonStyle.Primary).setDisabled(currentPage <= 1),
            new ButtonBuilder().setCustomId('btn_next').setLabel('下一页 ▶️').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages),
            new ButtonBuilder().setCustomId('btn_confirm').setLabel(`确认${mode === 'grant'?'发放':'移除'} (${selectedUserIds.size})`).setStyle(mode === 'grant' ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(selectedUserIds.size === 0)
        );

        const menuRow = new ActionRowBuilder().addComponents(selectMenu);

        const payload = { content: '', embeds: [embed], components: [menuRow, btnRow] };

        // 如果是更新交互
        if (i) {
            await i.update(payload);
        } else {
            await interaction.editReply(payload);
        }

        return await interaction.fetchReply(); // 返回消息对象用于绑定 Collector
    };

    // 4. 发送初始消息并启动 Collector
    const message = await renderPage();

    // 创建收集器：监听该消息上的所有按钮和下拉菜单
    // filter: 只有点击命令的人能操作，防止别人捣乱
    const collector = message.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time: 300000 // 5分钟超时
    });

    // 5. 处理交互事件 (这里就是 Py View 的回调逻辑)
    collector.on('collect', async (i) => {
        try {
            // --- 处理下拉菜单选择 ---
            if (i.isStringSelectMenu()) {
                // 更新 Set 中的选择状态
                const newlySelected = i.values;

                // 这里的逻辑稍微复杂点：StringSelectMenu 返回的是"当前选中的所有项"
                // 但仅仅是针对"当前页"的。我们需要把当前页没选中的从Set里踢掉，选中的加进去。

                // 1. 获取当前页所有可能的ID
                const currentPageIds = paginateData(targetUsers, currentPage, ITEMS_PER_PAGE).pageData.map(m => m.id);

                // 2. 遍历当前页ID
                currentPageIds.forEach(id => {
                    if (newlySelected.includes(id)) {
                        selectedUserIds.add(id); // 如果在返回列表里，添加
                    } else {
                        selectedUserIds.delete(id); // 如果不在返回列表里（但在当前页），说明被取消了
                    }
                });

                // 刷新界面
                await renderPage(i);
            }

            // --- 处理按钮 ---
            else if (i.isButton()) {
                if (i.customId === 'btn_prev') {
                    currentPage--;
                    await renderPage(i);
                } else if (i.customId === 'btn_next') {
                    currentPage++;
                    await renderPage(i);
                } else if (i.customId === 'btn_confirm') {
                    // 执行最终逻辑
                    await i.deferUpdate(); // 先转圈，防止处理慢
                    collector.stop('finished'); // 停止监听

                    let success = 0, fail = 0;
                    const idArray = Array.from(selectedUserIds);

                    // 批量操作
                    for (const uid of idArray) {
                        const member = await interaction.guild.members.fetch(uid).catch(() => null);
                        if (member) {
                            try {
                                if (mode === 'grant') await member.roles.add(role);
                                else await member.roles.remove(role);
                                success++;
                            } catch (e) { fail++; }
                        } else { fail++; }
                    }

                    await interaction.editReply({
                        content: `✅ **操作完成**\n成功: ${success} 人\n失败: ${fail} 人`,
                        embeds: [], components: []
                    });
                }
            }
        } catch (err) {
            console.error('Collector Error:', err);
            // 尝试恢复
            if (!i.replied && !i.deferred) await i.reply({content: '❌ 交互出错', ephemeral: true});
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason !== 'finished') {
            interaction.editReply({ content: '⚠️ 操作已超时，请重新打开面板。', components: [] }).catch(() => {});
        }
    });
}

/**
 * 显示批量发放身份组的指南
 * @param {import('discord.js').Interaction} interaction
 */
async function showBulkGrantGuide(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
        .setTitle('🏆 批量发放身份组指南')
        .setColor('#5865F2') // Discord 蓝色
        .setDescription(
            "为了防止误操作，我们移除了“一键发放”功能。您可以通过以下两种推荐的方法来安全地批量发放身份组：\n---"
        )
        .addFields(
            {
                name: '方法一：使用本机器人的手动发放功能',
                value:
                    "1. 在管理面板上，点击 **`手动发放`** 按钮。\n" +
                    "2. 机器人会列出**第一页**尚未拥有身份组的参赛者。\n" +
                    "3. 点击下方的**下拉菜单**，选择本页所有您想发放身份组的用户（可以多选）。\n" +
                    "4. 点击 **`确认发放`** 按钮。\n" +
                    "5. **如果参与者多于一页**，请点击 **`下一页`** 按钮，然后重复第 3 和第 4 步，直到完成所有页面的发放。\n\n" +
                    "**优点**：安全可控，无需任何额外权限或机器人。"
            },
            {
                name: '方法二：使用专业的管理机器人（推荐）',
                value:
                    "如果参赛人数非常多，手动分页会很繁琐。更高效的方法是：\n\n" +
                    "1. 在管理面板上，点击 **`导出参赛者名单`** 按钮，获取所有参赛者的用户ID。\n" +
                    "2. 复制这些用户ID。\n" +
                    "3. 使用服务器中其他管理机器人的批量添加身份组命令。\n" +
                    "**优点**：效率最高，尤其适合参赛人数众多的情况。"
            }
        )
        .setFooter({ text: '这是一个操作指南，点击此处的按钮不会执行任何实际操作。' });

    await interaction.editReply({ embeds: [embed] });
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
    showBulkGrantGuide,
    listAllParticipants,
    grantRoleOnSubmission
};