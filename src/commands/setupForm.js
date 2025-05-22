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

// 配置允许使用此指令的身份组名称（可以根据需要修改）
const ALLOWED_ROLE_NAMES = [
    '管理员',
    '议案管理员',
    '版主',
    'Admin',
    'Moderator'
    // 在这里添加更多允许的身份组名称
];

async function execute(interaction) {
    try {
        // 检查用户权限
        const hasPermission = checkUserPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: '您没有权限使用此指令。需要管理员权限或特定身份组权限。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        const targetChannel = interaction.options.getChannel('目标频道');
        const requiredVotes = interaction.options.getInteger('所需支持数');
        const forumChannel = interaction.options.getChannel('论坛频道');
        
        // 验证频道类型
        if (targetChannel.type !== 0) { // 0 = GUILD_TEXT
            return interaction.reply({
                content: '目标频道必须是文字频道。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        if (forumChannel.type !== 15) { // 15 = GUILD_FORUM
            return interaction.reply({
                content: '论坛频道必须是论坛类型频道。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        if (requiredVotes < 1) {
            return interaction.reply({
                content: '所需支持数必须大于0。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log('开始设置表单...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Target Channel:', targetChannel.name, targetChannel.id);
        console.log('Required Votes:', requiredVotes);
        console.log('Forum Channel:', forumChannel.name, forumChannel.id);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 存储设置到数据库
        const settings = {
            guildId: interaction.guild.id,
            targetChannelId: targetChannel.id,
            requiredVotes: requiredVotes,
            forumChannelId: forumChannel.id,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveSettings(interaction.guild.id, settings);
        
        // 检查设置是否成功保存
        const savedSettings = await require('../utils/database').getSettings(interaction.guild.id);
        console.log('验证保存的设置:', savedSettings);
        
        // 创建表单入口按钮（只保留填写表单按钮）
        const message = await interaction.channel.send({
            content: `📝议案预审核提交入口\n请点击下方的按钮，并按照议案表格的格式填写内容。\n\n**表单包含以下字段：**\n• 议案标题：简洁明了，不超过30字\n• 提案原因：说明提出此动议的原因\n• 议案动议：详细说明您的议案内容\n• 执行方案：说明如何落实此动议\n• 投票时间：建议的投票持续时间\n\n提交后，议案需要获得 **${requiredVotes}** 个支持才能进入讨论阶段。\n\n*如需删除此入口，请使用 \`/deleteentry\` 指令*\n*如需撤回议案，请使用 \`/withdrawproposal\` 指令*`,
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
        
        await interaction.reply({ 
            content: `✅ 表单设置完成！\n\n**配置信息：**\n• 提交目标频道：${targetChannel}\n• 所需支持数：${requiredVotes}\n• 论坛频道：${forumChannel}\n• 入口消息ID：\`${message.id}\`\n\n用户现在可以点击按钮填写表单。`,
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

/**
 * 检查用户是否有权限使用此指令
 * @param {GuildMember} member - 服务器成员对象
 * @returns {boolean} 是否有权限
 */
function checkUserPermission(member) {
    // 检查是否有管理员权限
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }
    
    // 检查是否有管理服务器权限
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }
    
    // 检查是否有管理频道权限
    if (member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return true;
    }
    
    // 检查是否拥有允许的身份组
    const hasAllowedRole = member.roles.cache.some(role => 
        ALLOWED_ROLE_NAMES.includes(role.name)
    );
    
    if (hasAllowedRole) {
        return true;
    }
    
    // 检查是否是服务器所有者
    if (member.guild.ownerId === member.user.id) {
        return true;
    }
    
    return false;
}

/**
 * 获取允许的身份组列表（用于其他文件调用）
 * @returns {string[]} 允许的身份组名称数组
 */
function getAllowedRoles() {
    return [...ALLOWED_ROLE_NAMES];
}

module.exports = {
    data,
    execute,
    getAllowedRoles,
    checkUserPermission
};