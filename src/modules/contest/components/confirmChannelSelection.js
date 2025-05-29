const { 
    EmbedBuilder,
    ActionRowBuilder, 
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

function createConfirmChannelSelection(applicationData, allowedExternalServers = []) {
    const embed = new EmbedBuilder()
        .setTitle('🏗️ 确认建立赛事频道')
        .setDescription(`**赛事名称：** ${applicationData.formData.title}\n\n请先选择是否允许外部服务器投稿，然后点击确认按钮继续设置频道详情。`)
        .setColor('#4CAF50')
        .setTimestamp();

    const components = [];

    // 外部服务器投稿选择下拉菜单
    const externalServerSelect = new StringSelectMenuBuilder()
        .setCustomId(`external_server_select_${applicationData.id}`)
        .setPlaceholder('选择是否允许外部服务器投稿')
        .addOptions([
            {
                label: '否 - 仅允许本服务器投稿',
                description: '只有本服务器的链接可以投稿',
                value: 'no',
                emoji: '🏠'
            },
            {
                label: '是 - 允许外部服务器投稿',
                description: allowedExternalServers.length > 0 ? 
                    `允许 ${allowedExternalServers.length} 个外部服务器投稿` : 
                    '允许外部服务器投稿（需要管理员配置）',
                value: 'yes',
                emoji: '🌐'
            }
        ]);

    const selectRow = new ActionRowBuilder().addComponents(externalServerSelect);
    components.push(selectRow);

    // 确认按钮
    const buttonRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`proceed_channel_creation_${applicationData.id}`)
                .setLabel('📝 继续设置频道详情')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true), // 初始禁用，选择后启用
            new ButtonBuilder()
                .setCustomId(`cancel_channel_creation_${applicationData.id}`)
                .setLabel('❌ 取消')
                .setStyle(ButtonStyle.Secondary)
        );

    components.push(buttonRow);

    return { embed, components };
}

module.exports = {
    createConfirmChannelSelection
}; 