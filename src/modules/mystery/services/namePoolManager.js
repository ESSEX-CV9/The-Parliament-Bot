const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const namePoolStore = require('./namePoolStore');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');

const NAME_POOL_CUSTOM_ID_PREFIX = 'mystery_namepool:';
const PAGE_SIZE = 25;
const EXPIRED_MESSAGE = '⏱️ **这个名字库管理页面已经过期或无效。**\n请重新使用 `/管理 神秘名字库`。';
const FAILURE_MESSAGE = '❌ **名字库操作失败。**\n数据没有被修改，请稍后重试。';
const EMPTY_REJECTION_MESSAGE = '❌ **不能把神秘名字库删空。**\n\n至少需要保留 **1 个名字**，\n否则 `/神秘指令 取名字好麻烦` 将无法正常使用。';

function mainPanelPayload(total) {
    const embed = new EmbedBuilder()
        .setTitle('📚 神秘名字库管理')
        .setDescription([
            `当前共有 **${total} 个名字**。`,
            '',
            '这里的修改会立即影响：',
            '`/神秘指令 取名字好麻烦`',
            '',
            '名字库为全 Bot 共用，不区分服务器。',
        ].join('\n'));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mystery_namepool:add')
            .setLabel('添加名字')
            .setEmoji('➕')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('mystery_namepool:delete_page:0')
            .setLabel('删除名字')
            .setEmoji('➖')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('mystery_namepool:batch_delete')
            .setLabel('批量删除')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('mystery_namepool:view_page:0')
            .setLabel('查看名字库')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
}

function createNamesModal({ customId, title, label, placeholder }) {
    const input = new TextInputBuilder()
        .setCustomId('names')
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000);
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addComponents(new ActionRowBuilder().addComponents(input));
}

function clampPage(page, total) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return { page: Math.min(page, pageCount - 1), pageCount };
}

function deletePagePayload(names, requestedPage, content) {
    const { page, pageCount } = clampPage(requestedPage, names.length);
    const pageNames = names.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const embed = new EmbedBuilder()
        .setTitle('➖ 删除神秘名字')
        .setDescription(`第 ${page + 1} / ${pageCount} 页\n当前名字总数：${names.length}\n\n请选择要删除的名字，可多选。`);
    const select = new StringSelectMenuBuilder()
        .setCustomId(`mystery_namepool:delete_select:${page}`)
        .setPlaceholder('选择要删除的名字')
        .setMinValues(1)
        .setMaxValues(pageNames.length)
        .addOptions(pageNames.map(name => ({ label: name, value: name })));
    const navigation = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_namepool:delete_page:${Math.max(0, page - 1)}`)
            .setLabel('上一页')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`mystery_namepool:delete_page:${Math.min(pageCount - 1, page + 1)}`)
            .setLabel('下一页')
            .setEmoji('➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pageCount - 1),
    );
    return {
        ...(content ? { content } : {}),
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select), navigation],
    };
}

function viewPagePayload(names, requestedPage) {
    const { page, pageCount } = clampPage(requestedPage, names.length);
    const pageNames = names.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const lines = pageNames.map((name, index) => `${page * PAGE_SIZE + index + 1}. ${name}`);
    const embed = new EmbedBuilder()
        .setTitle('📋 神秘名字库')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `当前总数：${names.length} · 第 ${page + 1} / ${pageCount} 页` });
    const navigation = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_namepool:view_page:${Math.max(0, page - 1)}`)
            .setLabel('上一页')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`mystery_namepool:view_page:${Math.min(pageCount - 1, page + 1)}`)
            .setLabel('下一页')
            .setEmoji('➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pageCount - 1),
    );
    return { embeds: [embed], components: [navigation] };
}

async function safePrivateResponse(interaction, payload) {
    try {
        if (interaction.deferred && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        console.error('[MysteryNamePool] 发送私密回复失败:', error);
    }
}

function createNamePoolManager({
    store = namePoolStore,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
} = {}) {
    async function openNamePoolManager(interaction) {
        if (!checkPermission(interaction.member)) {
            await safePrivateResponse(interaction, { content: permissionDeniedMessage() });
            return;
        }
        try {
            const names = await store.getNames();
            await interaction.reply({ ...mainPanelPayload(names.length), flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error('[MysteryNamePool] 打开管理面板失败:', error);
            await safePrivateResponse(interaction, { content: FAILURE_MESSAGE });
        }
    }

    async function handleNamePoolInteraction(interaction) {
        if (!checkPermission(interaction.member)) {
            await safePrivateResponse(interaction, { content: permissionDeniedMessage() });
            return true;
        }
        const customId = interaction.customId;
        if (typeof customId !== 'string' || !customId.startsWith(NAME_POOL_CUSTOM_ID_PREFIX)) return false;

        try {
            if (interaction.isButton?.() && customId === 'mystery_namepool:add') {
                await interaction.showModal(createNamesModal({
                    customId: 'mystery_namepool:add_modal',
                    title: '添加神秘名字',
                    label: '一行一个名字',
                    placeholder: '我是大聪明\n今天不想取名\n神秘路人甲',
                }));
                return true;
            }
            if (interaction.isButton?.() && customId === 'mystery_namepool:batch_delete') {
                await interaction.showModal(createNamesModal({
                    customId: 'mystery_namepool:batch_delete_modal',
                    title: '批量删除神秘名字',
                    label: '一行一个名字',
                    placeholder: '嘉豪\n我是大聪明\n神秘路人甲',
                }));
                return true;
            }
            if (interaction.isModalSubmit?.() && customId === 'mystery_namepool:add_modal') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = await store.addNames(interaction.fields.getTextInputValue('names').split(/\r?\n/));
                await interaction.editReply({
                    content: [
                        '✅ **名字库已更新**', '',
                        `成功添加：**${result.added} 个**`,
                        `重复跳过：**${result.duplicates} 个**`,
                        `无效跳过：**${result.invalid} 个**`, '',
                        `当前总数：**${result.total} 个**`,
                    ].join('\n'),
                });
                return true;
            }
            if (interaction.isModalSubmit?.() && customId === 'mystery_namepool:batch_delete_modal') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = await store.removeNames(interaction.fields.getTextInputValue('names').split(/\r?\n/));
                if (result.rejectedEmpty) {
                    await interaction.editReply({ content: EMPTY_REJECTION_MESSAGE });
                } else {
                    await interaction.editReply({
                        content: [
                            '🗑️ **名字库已更新**', '',
                            `成功删除：**${result.removed} 个**`,
                            `未找到：**${result.notFound} 个**`, '',
                            `当前剩余：**${result.total} 个**`,
                        ].join('\n'),
                    });
                }
                return true;
            }

            const deletePageMatch = /^mystery_namepool:delete_page:(\d+)$/.exec(customId);
            if (interaction.isButton?.() && deletePageMatch) {
                await interaction.deferUpdate();
                const names = await store.getNames();
                await interaction.editReply(deletePagePayload(names, Number(deletePageMatch[1])));
                return true;
            }
            const viewPageMatch = /^mystery_namepool:view_page:(\d+)$/.exec(customId);
            if (interaction.isButton?.() && viewPageMatch) {
                await interaction.deferUpdate();
                const names = await store.getNames();
                await interaction.editReply(viewPagePayload(names, Number(viewPageMatch[1])));
                return true;
            }
            const deleteSelectMatch = /^mystery_namepool:delete_select:(\d+)$/.exec(customId);
            if (interaction.isStringSelectMenu?.() && deleteSelectMatch) {
                await interaction.deferUpdate();
                const result = await store.removeNames(interaction.values);
                if (result.rejectedEmpty) {
                    await interaction.editReply({ content: EMPTY_REJECTION_MESSAGE, embeds: [], components: [] });
                } else {
                    const names = await store.getNames();
                    const status = `🗑️ 成功删除：**${result.removed} 个** · 未找到：**${result.notFound} 个**`;
                    await interaction.editReply(deletePagePayload(names, Number(deleteSelectMatch[1]), status));
                }
                return true;
            }

            await safePrivateResponse(interaction, { content: EXPIRED_MESSAGE });
            return true;
        } catch (error) {
            console.error(`[MysteryNamePool] 处理交互失败 (customId=${customId}):`, error);
            await safePrivateResponse(interaction, { content: FAILURE_MESSAGE });
            return true;
        }
    }

    return { openNamePoolManager, handleNamePoolInteraction };
}

const defaultManager = createNamePoolManager();

module.exports = {
    NAME_POOL_CUSTOM_ID_PREFIX,
    createNamePoolManager,
    openNamePoolManager: defaultManager.openNamePoolManager,
    handleNamePoolInteraction: defaultManager.handleNamePoolInteraction,
};
