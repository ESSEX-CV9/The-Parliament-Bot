// src/commands/debugPermissions.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getUserPermissionDetails, getAllowedRoles } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('debugpermissions')
    .setDescription('调试权限信息（仅用于测试）')
    .addUserOption(option => 
        option.setName('用户')
            .setDescription('要检查权限的用户（不填则检查自己）')
            .setRequired(false));

async function execute(interaction) {
    try {
        const targetUser = interaction.options.getUser('用户') || interaction.user;
        
        console.log(`开始调试用户权限: ${targetUser.tag} (${targetUser.id})`);
        
        // 安全获取成员信息
        let targetMember;
        try {
            targetMember = await interaction.guild.members.fetch(targetUser.id);
        } catch (fetchError) {
            console.error('获取成员信息失败:', fetchError);
            return interaction.reply({
                content: `❌ 无法获取用户 ${targetUser.tag} 的成员信息。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log(`成功获取成员信息: ${targetMember.user.tag}`);
        
        // 安全获取权限详情
        let permissionDetails;
        try {
            permissionDetails = getUserPermissionDetails(targetMember);
        } catch (permError) {
            console.error('获取权限详情失败:', permError);
            return interaction.reply({
                content: `❌ 获取权限详情时出错: ${permError.message}`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log('权限详情:', permissionDetails);
        
        // 安全构建调试信息
        const safeUserRoleNames = permissionDetails.userRoleNames || [];
        const safeAllowedUserRoles = permissionDetails.allowedUserRoles || [];
        const safeAllowedRolesList = permissionDetails.allowedRolesList || [];
        
        const debugInfo = `**🔍 权限调试信息**\n\n` +
            `**用户：** ${permissionDetails.userTag || '未知'} (${permissionDetails.userId || '未知'})\n` +
            `**是否为服务器所有者：** ${permissionDetails.isOwner ? '✅ 是' : '❌ 否'}\n` +
            `**是否有原生权限：** ${permissionDetails.hasNativePermissions ? '✅ 是' : '❌ 否'}\n` +
            `**最终权限结果：** ${permissionDetails.hasPermission ? '✅ 有权限' : '❌ 无权限'}\n\n` +
            `**用户所有身份组（${safeUserRoleNames.length}个）：**\n${safeUserRoleNames.length > 0 ? safeUserRoleNames.map(role => `• \`${role}\``).join('\n') : '• 无身份组'}\n\n` +
            `**匹配的允许身份组（${safeAllowedUserRoles.length}个）：**\n${safeAllowedUserRoles.length > 0 ? safeAllowedUserRoles.map(role => `• \`${role}\``).join('\n') : '• 无匹配'}\n\n` +
            `**系统允许的身份组（${safeAllowedRolesList.length}个）：**\n${safeAllowedRolesList.map(role => `• \`${role}\``).join('\n')}`;
        
        await interaction.reply({
            content: debugInfo,
            flags: MessageFlags.Ephemeral
        });
        
    } catch (error) {
        console.error('调试权限时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        await interaction.reply({
            content: `❌ 调试权限时出错: ${error.message}\n请查看控制台获取详细信息。`,
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};