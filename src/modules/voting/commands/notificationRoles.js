const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { saveNotificationConfig, getNotificationConfig } = require('../services/notificationManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('投票-设置通知身份组')
        .setDescription('设置自助通知身份组系统')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand(subcommand =>
            subcommand
                .setName('添加身份组')
                .setDescription('添加一个可自助获取的通知身份组')
                .addRoleOption(option =>
                    option.setName('身份组')
                        .setDescription('要添加的身份组')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('描述')
                        .setDescription('身份组的描述说明')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('移除身份组')
                .setDescription('移除一个通知身份组')
                .addRoleOption(option =>
                    option.setName('身份组')
                        .setDescription('要移除的身份组')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('创建入口')
                .setDescription('在当前频道创建通知身份组获取入口'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('查看配置')
                .setDescription('查看当前的通知身份组配置')),
    
    async execute(interaction) {
        try {
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;
            
            switch (subcommand) {
                case '添加身份组':
                    await handleAddRole(interaction, guildId);
                    break;
                case '移除身份组':
                    await handleRemoveRole(interaction, guildId);
                    break;
                case '创建入口':
                    await handleCreateEntry(interaction, guildId);
                    break;
                case '查看配置':
                    await handleViewConfig(interaction, guildId);
                    break;
            }
        } catch (error) {
            console.error('通知身份组命令错误:', error);
            await interaction.reply({
                content: '❌ 操作失败，请稍后重试',
                ephemeral: true
            });
        }
    }
};

async function handleAddRole(interaction, guildId) {
    const role = interaction.options.getRole('身份组');
    const description = interaction.options.getString('描述');
    
    // 检查权限
    const botMember = interaction.guild.members.me;
    if (role.position >= botMember.roles.highest.position) {
        await interaction.reply({
            content: '❌ 机器人无法管理这个身份组，请确保机器人的身份组权限高于目标身份组',
            ephemeral: true
        });
        return;
    }
    
    const config = await getNotificationConfig(guildId);
    
    // 检查是否已存在
    if (config.roles.some(r => r.roleId === role.id)) {
        await interaction.reply({
            content: '❌ 这个身份组已经在通知列表中了',
            ephemeral: true
        });
        return;
    }
    
    // 添加身份组
    config.roles.push({
        roleId: role.id,
        roleName: role.name,
        description: description,
        addedAt: new Date().toISOString()
    });
    
    await saveNotificationConfig(guildId, config);
    
    await interaction.reply({
        content: `✅ 成功添加通知身份组：${role.name}\n📝 描述：${description}`,
        ephemeral: true
    });
}

async function handleRemoveRole(interaction, guildId) {
    const role = interaction.options.getRole('身份组');
    
    const config = await getNotificationConfig(guildId);
    const roleIndex = config.roles.findIndex(r => r.roleId === role.id);
    
    if (roleIndex === -1) {
        await interaction.reply({
            content: '❌ 这个身份组不在通知列表中',
            ephemeral: true
        });
        return;
    }
    
    // 移除身份组
    config.roles.splice(roleIndex, 1);
    await saveNotificationConfig(guildId, config);
    
    await interaction.reply({
        content: `✅ 成功移除通知身份组：${role.name}`,
        ephemeral: true
    });
}

async function handleCreateEntry(interaction, guildId) {
    const config = await getNotificationConfig(guildId);
    
    if (config.roles.length === 0) {
        await interaction.reply({
            content: '❌ 请先添加至少一个通知身份组',
            ephemeral: true
        });
        return;
    }
    
    // 创建入口嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('🔔 通知身份组自助获取')
        .setDescription('点击下方按钮来选择您想要接收的通知类型')
        .setColor(0x00FF00)
        .addFields({
            name: '📋 可选择的通知身份组',
            value: config.roles.map(role => `• **${role.roleName}** - ${role.description}`).join('\n')
        })
        .setFooter({ text: '您可以随时更改您的通知设置' })
        .setTimestamp();
    
    // 创建获取通知按钮
    const button = new ButtonBuilder()
        .setCustomId('notification_roles_entry')
        .setLabel('🔔 管理我的通知设置')
        .setStyle(ButtonStyle.Success);
    
    const row = new ActionRowBuilder().addComponents(button);
    
    // 发送到当前频道
    await interaction.channel.send({
        embeds: [embed],
        components: [row]
    });
    
    await interaction.reply({
        content: '✅ 通知身份组入口已创建在当前频道',
        ephemeral: true
    });
}

async function handleViewConfig(interaction, guildId) {
    const config = await getNotificationConfig(guildId);
    
    const embed = new EmbedBuilder()
        .setTitle('📊 通知身份组配置')
        .setColor(0x0099FF)
        .setTimestamp();
    
    if (config.roles.length === 0) {
        embed.setDescription('❌ 暂未配置任何通知身份组');
    } else {
        const roleList = config.roles.map((role, index) => 
            `${index + 1}. **${role.roleName}** (ID: ${role.roleId})\n   📝 ${role.description}\n   📅 添加时间: ${new Date(role.addedAt).toLocaleString('zh-CN')}`
        ).join('\n\n');
        
        embed.setDescription(roleList);
        embed.addFields({
            name: '📈 统计信息',
            value: `总身份组数量: ${config.roles.length}`
        });
    }
    
    await interaction.reply({
        embeds: [embed],
        ephemeral: true
    });
} 