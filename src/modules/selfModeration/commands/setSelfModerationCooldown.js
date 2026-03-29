// src\modules\selfModeration\commands\setSelfModerationCooldown.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveSelfModerationGlobalCooldown, getSelfModerationGlobalCooldown } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('搬石公投-设置自助管理冷却')
    .setDescription('设置所有用户使用自助管理功能的全局冷却时间')
    .addSubcommand(subcommand =>
        subcommand
            .setName('删除冷却')
            .setDescription('设置所有用户使用删除消息功能的冷却时间')
            .addIntegerOption(option =>
                option.setName('冷却时间')
                    .setDescription('冷却时间（分钟，0表示无冷却）')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(1440))) // 最多24小时
    .addSubcommand(subcommand =>
        subcommand
            .setName('禁言冷却')
            .setDescription('设置所有用户使用禁言功能的冷却时间')
            .addIntegerOption(option =>
                option.setName('冷却时间')
                    .setDescription('冷却时间（分钟，0表示无冷却）')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(1440))) // 最多24小时
    .addSubcommand(subcommand =>
        subcommand
            .setName('严肃禁言冷却')
            .setDescription('设置所有用户使用严肃禁言功能的冷却时间')
            .addIntegerOption(option =>
                option.setName('冷却时间')
                    .setDescription('冷却时间（分钟，0表示无冷却）')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(1440))) // 最多24小时
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看设置')
            .setDescription('查看当前的全局冷却时间设置'));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查用户权限（只有管理员可以设置）
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case '删除冷却':
                await handleSetGlobalCooldown(interaction, 'delete');
                break;
            case '禁言冷却':
                await handleSetGlobalCooldown(interaction, 'mute');
                break;
            case '严肃禁言冷却':
                await handleSetGlobalCooldown(interaction, 'serious_mute');
                break;
            case '查看设置':
                await handleViewGlobalCooldown(interaction);
                break;
        }

    } catch (error) {
        console.error('执行设置自助管理冷却指令时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理指令时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: '❌ 处理指令时出现错误，请稍后重试。'
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function handleSetGlobalCooldown(interaction, type) {
    try {
        const cooldownMinutes = interaction.options.getInteger('冷却时间');
        
        let actionName = '禁言用户';
        if (type === 'delete') {
            actionName = '删除消息';
        } else if (type === 'serious_mute') {
            actionName = '严肃禁言';
        }
        
        // 保存全局冷却时间设置
        await saveSelfModerationGlobalCooldown(interaction.guild.id, type, cooldownMinutes);
        
        let response;
        if (cooldownMinutes === 0) {
            response = `✅ 已取消所有用户的${actionName}功能冷却时间。\n\n现在所有用户都可以无限制使用${actionName}功能。`;
        } else {
            const hours = Math.floor(cooldownMinutes / 60);
            const minutes = cooldownMinutes % 60;
            let timeText = '';
            if (hours > 0) {
                timeText += `${hours}小时`;
            }
            if (minutes > 0) {
                timeText += `${minutes}分钟`;
            }
            
            response = `✅ 已设置所有用户的${actionName}功能冷却时间为 **${timeText}**。\n\n现在所有用户使用${actionName}功能后需要等待${timeText}才能再次使用。`;
        }
        
        console.log(`${interaction.user.tag} 设置了服务器 ${interaction.guild.name} 的${actionName}全局冷却时间为 ${cooldownMinutes}分钟`);
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('设置全局冷却时间时出错:', error);
        await interaction.editReply({
            content: '❌ 设置全局冷却时间时出现错误。'
        });
    }
}

async function handleViewGlobalCooldown(interaction) {
    try {
        // 获取全局冷却时间设置
        const deleteCooldown = await getSelfModerationGlobalCooldown(interaction.guild.id, 'delete');
        const muteCooldown = await getSelfModerationGlobalCooldown(interaction.guild.id, 'mute');
        const seriousMuteCooldown = await getSelfModerationGlobalCooldown(interaction.guild.id, 'serious_mute');
        
        let response = `**🕐 自助管理全局冷却时间设置**\n\n`;
        
        // 删除消息冷却
        if (deleteCooldown > 0) {
            const hours = Math.floor(deleteCooldown / 60);
            const minutes = deleteCooldown % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;
            
            response += `🗑️ **删除消息冷却：** ${timeText}\n`;
        } else {
            response += `🗑️ **删除消息冷却：** 无限制\n`;
        }
        
        // 禁言用户冷却
        if (muteCooldown > 0) {
            const hours = Math.floor(muteCooldown / 60);
            const minutes = muteCooldown % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;
            
            response += `🔇 **禁言用户冷却：** ${timeText}\n`;
        } else {
            response += `🔇 **禁言用户冷却：** 无限制\n`;
        }

        // 严肃禁言冷却
        if (seriousMuteCooldown > 0) {
            const hours = Math.floor(seriousMuteCooldown / 60);
            const minutes = seriousMuteCooldown % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;

            response += `🚨 **严肃禁言冷却：** ${timeText}\n`;
        } else {
            response += `🚨 **严肃禁言冷却：** 无限制\n`;
        }
        
        response += `\n💡 **说明：** 这些设置对服务器内所有用户生效。每个用户使用功能后需要等待相应时间才能再次使用。`;
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('查看全局冷却时间时出错:', error);
        await interaction.editReply({
            content: '❌ 查看全局冷却时间时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
};
