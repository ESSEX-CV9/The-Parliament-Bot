const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

/**
 * 创建“确认建立赛事频道”的选择界面
 * @param {object} applicationData - 赛事申请数据
 * @param {string[]} allowedExternalServers - 外部服务器白名单（用于描述展示）
 * @param {boolean} showExternalSelect - 是否显示“外部服务器投稿”选择（受全局开关控制）
 */
function createConfirmChannelSelection(applicationData, allowedExternalServers = [], showExternalSelect = true) {
    const descriptionText = showExternalSelect
        ? `**赛事名称：** ${applicationData.formData.title}\n\n请先选择是否允许外部服务器投稿，然后点击确认按钮继续设置频道详情。`
        : `**赛事名称：** ${applicationData.formData.title}\n\n管理员已关闭外部投稿开关，此比赛默认仅允许本服务器投稿。\n请点击下方按钮继续设置频道详情。`;

    const embed = new EmbedBuilder()
        .setTitle('🏗️ 确认建立赛事频道')
        .setDescription(descriptionText)
        .setColor('#4CAF50')
        .setTimestamp();

    const components = [];

    // 当允许显示外部投稿选择时，渲染选择下拉
    if (showExternalSelect) {
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
                    description: (allowedExternalServers && allowedExternalServers.length > 0) ?
                        `允许 ${allowedExternalServers.length} 个外部服务器投稿` :
                        '允许外部服务器投稿（需要管理员配置）',
                    value: 'yes',
                    emoji: '🌐'
                }
            ]);

        const selectRow = new ActionRowBuilder().addComponents(externalServerSelect);
        components.push(selectRow);
    }

    // 确认与取消按钮
    const proceedButton = new ButtonBuilder()
        .setLabel('📝 继续设置频道详情')
        .setStyle(ButtonStyle.Primary);

    // 当不显示选择时，直接启用并携带 allowExternalServers=false
    if (showExternalSelect) {
        proceedButton
            .setCustomId(`proceed_channel_creation_${applicationData.id}`)
            .setDisabled(true); // 选择后启用
    } else {
        proceedButton
            .setCustomId(`proceed_channel_creation_${applicationData.id}_false`)
            .setDisabled(false); // 直接启用
    }

    const buttonRow = new ActionRowBuilder()
        .addComponents(
            proceedButton,
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