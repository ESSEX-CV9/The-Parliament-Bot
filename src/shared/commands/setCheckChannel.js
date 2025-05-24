// src/commands/setCheckChannel.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveCheckChannelSettings, getCheckChannelSettings } = require('../utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('setcheckchannel')
    .setDescription('设置过期提案检查报告发送频道')
    .addChannelOption(option => 
        option.setName('频道')
            .setDescription('接收过期提案检查报告的频道')
            .setRequired(true))
    .addBooleanOption(option => 
        option.setName('启用')
            .setDescription('是否启用检查报告（默认启用）')
            .setRequired(false));

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

        const targetChannel = interaction.options.getChannel('频道');
        const enabled = interaction.options.getBoolean('启用') ?? true;
        
        // 验证频道类型
        if (targetChannel.type !== 0) { // 0 = GUILD_TEXT
            return interaction.editReply({
                content: '❌ 目标频道必须是文字频道。'
            });
        }
        
        // 检查机器人在目标频道的权限
        const botMember = interaction.guild.members.me;
        const channelPermissions = targetChannel.permissionsFor(botMember);
        
        if (!channelPermissions || !channelPermissions.has('SendMessages')) {
            return interaction.editReply({
                content: `❌ 机器人在目标频道 ${targetChannel} 没有发送消息的权限。`
            });
        }

        if (!channelPermissions.has('EmbedLinks')) {
            return interaction.editReply({
                content: `❌ 机器人在目标频道 ${targetChannel} 没有嵌入链接的权限。`
            });
        }
        
        console.log('设置检查报告频道...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Check Channel:', targetChannel.name, targetChannel.id);
        console.log('Enabled:', enabled);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 存储设置到数据库
        const checkSettings = {
            guildId: interaction.guild.id,
            checkChannelId: targetChannel.id,
            enabled: enabled,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveCheckChannelSettings(interaction.guild.id, checkSettings);
        
        // 发送测试消息验证设置
        try {
            const testMessage = await targetChannel.send({
                content: `📊 **过期提案检查报告频道设置完成**\n\n由 <@${interaction.user.id}> 设置\n设置时间: <t:${Math.floor(Date.now() / 1000)}:f>\n\n此频道将接收定期的过期提案检查报告。`
            });
            
            await interaction.editReply({ 
                content: `✅ **检查报告频道设置完成！**\n\n**配置信息：**\n• **报告频道：** ${targetChannel}\n• **状态：** ${enabled ? '✅ 启用' : '❌ 禁用'}\n• **测试消息ID：** \`${testMessage.id}\`\n\n系统现在会将过期提案检查报告发送到指定频道。`
            });
            
        } catch (sendError) {
            console.error('发送测试消息失败:', sendError);
            return interaction.editReply({
                content: `❌ 设置保存成功，但发送测试消息失败。请检查机器人权限。错误信息：${sendError.message}`
            });
        }
        
        console.log(`检查报告频道设置完成 - 频道: ${targetChannel.name}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('设置检查报告频道时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置检查报告频道时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置检查报告频道时出错：${error.message}\n请查看控制台获取详细信息。`
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};