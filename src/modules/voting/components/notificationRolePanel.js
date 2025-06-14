const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { getNotificationConfig, getUserRoleSettings, saveUserRoleSettings } = require('../services/notificationManager');

async function handleNotificationRoleEntry(interaction) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        
        const config = await getNotificationConfig(guildId);
        
        if (config.roles.length === 0) {
            await interaction.reply({
                content: '❌ 暂时没有可选择的通知身份组',
                ephemeral: true
            });
            return;
        }
        
        // 创建初始界面
        const { embed, components } = await createNotificationInterface(config, interaction.member);
        
        await interaction.reply({
            embeds: [embed],
            components: [components],
            ephemeral: true
        });
        
    } catch (error) {
        console.error('处理通知身份组入口错误:', error);
        
        // 安全的错误回复
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 操作失败，请稍后重试',
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('错误回复失败:', replyError);
        }
    }
}

async function handleNotificationRoleSelect(interaction) {
    // 立即延迟回复，防止超时
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
    }
    
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const selectedRoleIds = interaction.values;
        
        const config = await getNotificationConfig(guildId);
        const member = interaction.member;
        
        // 获取用户当前拥有的相关身份组
        const currentRelevantRoles = config.roles
            .filter(role => member.roles.cache.has(role.roleId))
            .map(role => role.roleId);
        
        // 计算需要添加和移除的身份组
        const rolesToAdd = selectedRoleIds.filter(roleId => !currentRelevantRoles.includes(roleId));
        const rolesToRemove = currentRelevantRoles.filter(roleId => !selectedRoleIds.includes(roleId));
        
        let changes = [];
        let hasError = false;
        
        // 批量处理身份组操作
        const roleOperations = [];
        
        // 添加身份组操作
        for (const roleId of rolesToAdd) {
            roleOperations.push(
                member.roles.add(roleId).then(() => {
                    const role = config.roles.find(r => r.roleId === roleId);
                    changes.push(`✅ 添加：${role?.roleName || roleId}`);
                }).catch(error => {
                    console.error(`添加身份组 ${roleId} 失败:`, error);
                    const role = config.roles.find(r => r.roleId === roleId);
                    changes.push(`❌ 添加失败：${role?.roleName || roleId}`);
                    hasError = true;
                })
            );
        }
        
        // 移除身份组操作
        for (const roleId of rolesToRemove) {
            roleOperations.push(
                member.roles.remove(roleId).then(() => {
                    const role = config.roles.find(r => r.roleId === roleId);
                    changes.push(`➖ 移除：${role?.roleName || roleId}`);
                }).catch(error => {
                    console.error(`移除身份组 ${roleId} 失败:`, error);
                    const role = config.roles.find(r => r.roleId === roleId);
                    changes.push(`❌ 移除失败：${role?.roleName || roleId}`);
                    hasError = true;
                })
            );
        }
        
        // 等待所有身份组操作完成
        await Promise.allSettled(roleOperations);
        
        // 保存用户设置
        await saveUserRoleSettings(guildId, userId, selectedRoleIds);
        
        // 重新获取用户最新的身份组状态
        await member.fetch();
        
        // 创建更新后的界面
        const { embed, components } = await createNotificationInterface(config, member, changes);
        
        // 使用 editReply 而不是 update，因为我们已经 defer 了
        await interaction.editReply({
            embeds: [embed],
            components: [components]
        });
        
    } catch (error) {
        console.error('处理通知身份组选择错误:', error);
        
        // 安全的错误处理
        try {
            if (interaction.deferred) {
                await interaction.editReply({
                    content: '❌ 更新失败，请稍后重试',
                    embeds: [],
                    components: []
                });
            } else if (!interaction.replied) {
                await interaction.reply({
                    content: '❌ 更新失败，请稍后重试',
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('错误回复失败:', replyError);
        }
    }
}

// 创建通知界面的辅助函数
async function createNotificationInterface(config, member, changes = null) {
    // 获取用户当前的身份组
    const currentRoleIds = config.roles
        .filter(role => member.roles.cache.has(role.roleId))
        .map(role => role.roleId);
    
    // 创建选择菜单
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('notification_roles_select')
        .setPlaceholder('选择您想要的通知身份组...')
        .setMinValues(0)
        .setMaxValues(config.roles.length);
    
    // 添加选项
    config.roles.forEach(role => {
        selectMenu.addOptions({
            label: role.roleName,
            description: role.description,
            value: role.roleId,
            default: currentRoleIds.includes(role.roleId)
        });
    });
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    // 创建嵌入消息
    let embed = new EmbedBuilder()
        .setColor(changes ? 0x00FF00 : 0x0099FF)
        .setTimestamp();
    
    if (changes && changes.length > 0) {
        // 显示更新结果
        embed.setTitle('🔔 通知设置已更新');
        embed.setDescription('**变更情况：**\n' + changes.join('\n') + '\n\n**继续管理您的通知设置：**\n您可以继续在下方选择菜单中调整您的通知身份组。');
    } else if (changes) {
        // 没有变更
        embed.setTitle('🔔 通知设置');
        embed.setDescription('没有进行任何变更\n\n**继续管理您的通知设置：**\n您可以继续在下方选择菜单中调整您的通知身份组。');
    } else {
        // 显示初始界面
        embed.setTitle('🔔 管理您的通知设置');
        embed.setDescription('**选择您想要接收通知的身份组：**\n您可以随时在下方菜单中修改您的选择。');
    }
    
    // 显示当前状态
    if (currentRoleIds.length > 0) {
        const currentRoles = config.roles
            .filter(role => currentRoleIds.includes(role.roleId))
            .map(role => `• ${role.roleName}`)
            .join('\n');
        
        embed.addFields({
            name: '✅ 您当前拥有的通知身份组',
            value: currentRoles
        });
    } else {
        embed.addFields({
            name: '📭 通知状态',
            value: '您当前没有任何通知身份组'
        });
    }
    
    // 添加提示信息
    embed.addFields({
        name: '💡 使用提示',
        value: '• 选择多个身份组来接收不同类型的通知\n• 取消选择某个身份组将停止接收该类型通知\n• 您的设置会立即生效'
    });
    
    return { embed, components: row };
}

module.exports = {
    handleNotificationRoleEntry,
    handleNotificationRoleSelect
}; 