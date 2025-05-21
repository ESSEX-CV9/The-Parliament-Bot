// src/commands/setupForm.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { saveSettings } = require('../utils/database');

const data = new SlashCommandBuilder()
    .setName('setupform')
    .setDescription('设置一个表单入口')
    .addChannelOption(option => 
        option.setName('目标频道')
            .setDescription('表单提交后发送到的频道')
            .setRequired(true))
    .addIntegerOption(option => 
        option.setName('所需支持数')
            .setDescription('发布到论坛所需的支持数量')
            .setRequired(true))
    .addChannelOption(option => 
        option.setName('论坛频道')
            .setDescription('达到支持数后发布到的论坛频道')
            .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
    try {
        const targetChannel = interaction.options.getChannel('目标频道');
        const requiredVotes = interaction.options.getInteger('所需支持数');
        const forumChannel = interaction.options.getChannel('论坛频道');
        
        console.log('开始设置表单...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Target Channel:', targetChannel.name, targetChannel.id);
        console.log('Required Votes:', requiredVotes);
        console.log('Forum Channel:', forumChannel.name, forumChannel.id);
        
        // 存储设置到数据库
        const settings = {
            guildId: interaction.guild.id,
            targetChannelId: targetChannel.id,
            requiredVotes: requiredVotes,
            forumChannelId: forumChannel.id,
            timestamp: new Date().toISOString() // 添加时间戳便于调试
        };
        
        // 使用导入的saveSettings函数
        await saveSettings(interaction.guild.id, settings);
        
        // 检查设置是否成功保存
        const savedSettings = await require('../utils/database').getSettings(interaction.guild.id);
        console.log('验证保存的设置:', savedSettings);
        
        // 创建表单入口按钮
        const message = await interaction.channel.send({
            content: '📝 **点击下方按钮填写表单**',
            components: [
                {
                    type: 1, // ACTION_ROW
                    components: [
                        {
                            type: 2, // BUTTON
                            style: 1, // PRIMARY
                            label: '填写表单',
                            custom_id: 'open_form'
                        }
                    ]
                }
            ]
        });
        
        // 使用MessageFlags.Ephemeral替代ephemeral: true
        await interaction.reply({ 
            content: `表单设置完成！用户现在可以点击按钮填写表单。`,
            flags: MessageFlags.Ephemeral
        });
    } catch (error) {
        console.error('设置表单时出错:', error);
        await interaction.reply({
            content: '设置表单时出错，请查看控制台日志。',
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};