// src\modules\selfModeration\commands\setMessageTimeLimit.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveMessageTimeLimit, getMessageTimeLimit } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('搬石公投-设置消息时间限制')
    .setDescription('设置可以投票的消息的时间限制')
    .addSubcommand(subcommand =>
        subcommand
            .setName('设置')
            .setDescription('设置时间限制')
            .addIntegerOption(option =>
                option.setName('时间限制')
                    .setDescription('时间限制（小时，0表示无限制）')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(8760))) // 最多一年
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的时间限制设置'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清除')
            .setDescription('清除时间限制（允许对任何时间的消息投票）'));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查用户权限
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
            case '设置':
                await handleSetTimeLimit(interaction);
                break;
            case '查看':
                await handleViewTimeLimit(interaction);
                break;
            case '清除':
                await handleClearTimeLimit(interaction);
                break;
        }

    } catch (error) {
        console.error('执行设置消息时间限制指令时出错:', error);
        
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

async function handleSetTimeLimit(interaction) {
    try {
        const limitHours = interaction.options.getInteger('时间限制');
        
        await saveMessageTimeLimit(interaction.guild.id, limitHours);
        
        let response;
        if (limitHours === 0) {
            response = `✅ 已清除消息时间限制，现在可以对**任何时间**的消息进行投票。`;
        } else {
            const days = Math.floor(limitHours / 24);
            const hours = limitHours % 24;
            let timeText = '';
            if (days > 0) {
                timeText += `${days}天`;
            }
            if (hours > 0) {
                timeText += `${hours}小时`;
            }
            
            response = `✅ 已设置消息时间限制为 **${timeText}**，只能对过去${timeText}内的消息进行投票。`;
        }
        
        console.log(`${interaction.user.tag} 设置了服务器 ${interaction.guild.name} 的消息时间限制为 ${limitHours}小时`);
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('设置时间限制时出错:', error);
        await interaction.editReply({
            content: '❌ 设置时间限制时出现错误。'
        });
    }
}

async function handleViewTimeLimit(interaction) {
    try {
        const limitHours = await getMessageTimeLimit(interaction.guild.id);
        
        let response = `**⏰ 当前消息时间限制设置**\n\n`;
        
        if (limitHours === null || limitHours <= 0) {
            response += `🔓 **状态：** 无限制\n`;
            response += `📅 **说明：** 可以对任何时间的消息进行投票`;
        } else {
            const days = Math.floor(limitHours / 24);
            const hours = limitHours % 24;
            let timeText = '';
            if (days > 0) {
                timeText += `${days}天`;
            }
            if (hours > 0) {
                timeText += `${hours}小时`;
            }
            
            response += `🔒 **状态：** 已限制\n`;
            response += `⏰ **时间限制：** ${timeText}\n`;
            response += `📅 **说明：** 只能对过去${timeText}内的消息进行投票`;
        }
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('查看时间限制时出错:', error);
        await interaction.editReply({
            content: '❌ 查看时间限制时出现错误。'
        });
    }
}

async function handleClearTimeLimit(interaction) {
    try {
        await saveMessageTimeLimit(interaction.guild.id, 0);
        
        console.log(`${interaction.user.tag} 清除了服务器 ${interaction.guild.name} 的消息时间限制`);
        
        await interaction.editReply({
            content: '✅ 已清除消息时间限制，现在可以对**任何时间**的消息进行投票。'
        });
        
    } catch (error) {
        console.error('清除时间限制时出错:', error);
        await interaction.editReply({
            content: '❌ 清除时间限制时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
};