const { handleNotificationRoleEntry, handleNotificationRoleSelect } = require('./notificationRolePanel');

async function handleNotificationButton(interaction) {
    try {
        const customId = interaction.customId;
        
        if (customId === 'notification_roles_entry') {
            await handleNotificationRoleEntry(interaction);
        } else if (customId === 'notification_roles_select') {
            await handleNotificationRoleSelect(interaction);
        }
    } catch (error) {
        console.error('处理通知按钮错误:', error);
        await interaction.reply({
            content: '❌ 操作失败，请稍后重试',
            ephemeral: true
        });
    }
}

module.exports = {
    handleNotificationButton
}; 