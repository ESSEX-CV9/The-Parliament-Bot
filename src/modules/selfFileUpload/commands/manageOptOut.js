const { SlashCommandBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const {
    addUserToOptOutList,
    removeUserFromOptOutList,
    readOptOutList,
} = require('../../../core/utils/database');
const { createPaginatedList } = require('../services/paginationService');
const { batchAddUsersFromExcel } = require('../services/batchAddService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('管理自助补档屏蔽')
        .setDescription('管理不允许他人在其帖子下使用自助补档功能的用户列表 (仅管理员)。')
        .setDefaultMemberPermissions(0)
        .addSubcommand(subcommand =>
            subcommand.setName('添加').setDescription('添加一个用户到自助补档屏蔽列表。')
                .addUserOption(option => option.setName('用户').setDescription('要添加的用户').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('移除').setDescription('从自助补档屏蔽列表移除一个用户。')
                .addUserOption(option => option.setName('用户').setDescription('要移除的用户').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('列表').setDescription('查看当前的自助补档屏蔽列表（带翻页功能）。'))
        .addSubcommand(subcommand =>
            subcommand.setName('批量添加').setDescription('从Excel文件批量添加用户到屏蔽列表。')
                .addAttachmentOption(option => option.setName('excel文件').setDescription('包含用户ID列表的Excel文件').setRequired(true))),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case '添加': await handleAdd(interaction); break;
                case '移除': await handleRemove(interaction); break;
                case '列表': await handleList(interaction); break;
                case '批量添加': await handleBatchAdd(interaction); break;
            }
        } catch (error) {
            console.error('管理自助补档屏蔽列表时出错:', error);
            await interaction.editReply('❌ 操作时发生内部错误。');
        }
    },
};

async function handleAdd(interaction) {
    const targetUser = interaction.options.getUser('用户');
    const added = await addUserToOptOutList(targetUser.id);
    await interaction.editReply(added ? `✅ 已成功将用户 **${targetUser.tag}** 添加到自助补档屏蔽列表。` : `ℹ️ 用户 **${targetUser.tag}** 已在屏蔽列表中。`);
}

async function handleRemove(interaction) {
    const targetUser = interaction.options.getUser('用户');
    const removed = await removeUserFromOptOutList(targetUser.id);
    await interaction.editReply(removed ? `✅ 已成功从自助补档屏蔽列表移除用户 **${targetUser.tag}**。` : `ℹ️ 用户 **${targetUser.tag}** 不在屏蔽列表中。`);
}

async function handleBatchAdd(interaction) {
    const attachment = interaction.options.getAttachment('excel文件');
    await interaction.editReply('🔄 正在处理文件，请稍候...');
    const result = await batchAddUsersFromExcel(attachment);

    if (result.error) {
        return interaction.editReply(result.error);
    }
    await interaction.editReply(`✅ **批量添加完成！**\n\n- **成功添加**: ${result.addedCount} 个新用户\n- **跳过 (已存在)**: ${result.skippedCount} 个用户`);
}

async function handleList(interaction) {
    const optOutList = await readOptOutList();
    if (optOutList.length === 0) {
        return interaction.editReply('📝 当前自助补档屏蔽列表为空。');
    }

    const users = await Promise.all(
        optOutList.map(id => interaction.client.users.fetch(id).catch(() => ({ id, tag: '⚠️ 未知用户' })))
    );

    const formattedList = users.map((user, index) => `\`${index + 1}.\` ${user.tag} (\`${user.id}\`)`);

    await createPaginatedList(interaction, formattedList, {
        title: '🚫 自助补档屏蔽列表',
    });
}