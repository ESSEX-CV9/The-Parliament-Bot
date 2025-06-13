const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { createVotePanel } = require('./votePanel');
const { saveVoteData } = require('../services/voteManager');
const { generateVoteId, validateVoteOptions, validateEndTime, parseVoteSettings, validateRoles } = require('../utils/voteUtils');

function createVoteSetupModal() {
    const modal = new ModalBuilder()
        .setCustomId('vote_setup_modal')
        .setTitle('设置投票详情');

    // 投票主题
    const titleInput = new TextInputBuilder()
        .setCustomId('vote_title')
        .setLabel('投票主题')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('请输入投票主题...')
        .setRequired(true)
        .setMaxLength(100);

    // 投票选项
    const optionsInput = new TextInputBuilder()
        .setCustomId('vote_options')
        .setLabel('投票选项 (用逗号分隔)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('选项1,选项2,选项3')
        .setRequired(true)
        .setMaxLength(500);

    // 允许投票的身份组
    const rolesInput = new TextInputBuilder()
        .setCustomId('vote_roles')
        .setLabel('允许投票的身份组 (用逗号分隔，留空表示所有人)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('身份组1,身份组2')
        .setRequired(false)
        .setMaxLength(200);

    // 投票结束时间
    const endTimeInput = new TextInputBuilder()
        .setCustomId('vote_end_time')
        .setLabel('投票结束时间')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例：6d4h27m, 72h, 30min, 或直接输入分钟数')
        .setRequired(true)
        .setMaxLength(20);

    // 投票设置
    const settingsInput = new TextInputBuilder()
        .setCustomId('vote_settings')
        .setLabel('投票设置 (匿名:是/否,实时显示:是/否)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('匿名:否,实时显示:是')
        .setRequired(false)
        .setMaxLength(50);

    // 添加组件到模态框
    const firstRow = new ActionRowBuilder().addComponents(titleInput);
    const secondRow = new ActionRowBuilder().addComponents(optionsInput);
    const thirdRow = new ActionRowBuilder().addComponents(rolesInput);
    const fourthRow = new ActionRowBuilder().addComponents(endTimeInput);
    const fifthRow = new ActionRowBuilder().addComponents(settingsInput);

    modal.addComponents(firstRow, secondRow, thirdRow, fourthRow, fifthRow);

    return modal;
}

async function handleVoteSetupSubmit(interaction) {
    try {
        const title = interaction.fields.getTextInputValue('vote_title');
        const optionsText = interaction.fields.getTextInputValue('vote_options');
        const rolesText = interaction.fields.getTextInputValue('vote_roles') || '';
        const endTimeText = interaction.fields.getTextInputValue('vote_end_time');
        const settingsText = interaction.fields.getTextInputValue('vote_settings') || '';

        // 验证投票选项
        const optionsValidation = validateVoteOptions(optionsText);
        if (!optionsValidation.valid) {
            await interaction.reply({
                content: `❌ ${optionsValidation.error}`,
                ephemeral: true
            });
            return;
        }
        const options = optionsValidation.options;

        // 验证身份组
        const rolesValidation = validateRoles(interaction.guild, rolesText);
        if (!rolesValidation.valid) {
            await interaction.reply({
                content: `❌ ${rolesValidation.error}`,
                ephemeral: true
            });
            return;
        }
        const allowedRoles = rolesValidation.roles;

        // 验证结束时间
        const timeValidation = validateEndTime(endTimeText);
        if (!timeValidation.valid) {
            await interaction.reply({
                content: `❌ ${timeValidation.error}`,
                ephemeral: true
            });
            return;
        }
        const endTime = new Date(Date.now() + timeValidation.minutes * 60 * 1000);

        // 解析设置
        const { isAnonymous, isRealTime } = parseVoteSettings(settingsText);

        // 生成投票数据
        const voteId = generateVoteId();
        const voteData = {
            voteId,
            title,
            options,
            allowedRoles,
            endTime,
            isAnonymous,
            isRealTime,
            channelId: interaction.channel.id,
            guildId: interaction.guild.id,
            createdBy: interaction.user.id,
            votes: {},
            createdAt: new Date()
        };

        // 初始化投票选项
        options.forEach(option => {
            voteData.votes[option] = [];
        });

        // 保存投票数据
        await saveVoteData(voteData);

        // 创建投票面板
        const { embed, components } = createVotePanel(voteData);

        // 在频道发送投票消息
        const voteMessage = await interaction.channel.send({
            embeds: [embed],
            components: components
        });

        // 更新投票数据中的消息ID
        voteData.messageId = voteMessage.id;
        await saveVoteData(voteData);

        await interaction.reply({
            content: '✅ 投票已成功创建！',
            ephemeral: true
        });

    } catch (error) {
        console.error('处理投票设置错误:', error);
        await interaction.reply({
            content: '❌ 创建投票失败，请稍后重试',
            ephemeral: true
        });
    }
}

module.exports = {
    createVoteSetupModal,
    handleVoteSetupSubmit
}; 