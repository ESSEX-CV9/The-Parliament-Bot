const path = require('node:path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { createChannelAccessStore } = require('../utils/channelAccessStore');

const CHANNEL_ACCESS_CUSTOM_ID_PREFIX = 'mystery_manage:channel_access:';
const CHANNEL_ACCESS_MODAL_ID_PREFIX = 'mystery_manage:channel_access_modal:';
const CHANNEL_ID_PATTERN = /^[0-9]{5,32}$/;
const CONFIG_DESCRIPTION_LIMIT = 3900;
const EXPIRED_MESSAGE = '⚠️ 此频道设置交互已过期或无效。';
const FAILURE_MESSAGE = '❌ 处理频道设置时出现问题，请稍后再试。';

const defaultStore = createChannelAccessStore({
    filePath: path.join('data', 'mystery', 'channel-access.json'),
});

function panelPayload(config) {
    const embed = new EmbedBuilder()
        .setTitle('🔧 神秘频道设置')
        .setDescription([
            '默认仅允许线程和 Forum 帖子使用神秘指令；普通文字频道默认拒绝。',
            '',
            `白名单：**${config.whitelist.length}** 个频道`,
            `黑名单：**${config.blacklist.length}** 个频道`,
        ].join('\n'));

    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}add_whitelist`)
            .setLabel('➕ 添加白名单')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}remove_whitelist`)
            .setLabel('➖ 移除白名单')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}add_blacklist`)
            .setLabel('⛔ 添加黑名单')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}remove_blacklist`)
            .setLabel('✅ 移除黑名单')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}view`)
            .setLabel('📋 查看配置')
            .setStyle(ButtonStyle.Primary),
    );

    return { embeds: [embed], components: [controls] };
}

function createChannelModal(action, listName) {
    const operationLabel = action === 'add' ? '添加' : '移除';
    const listLabel = listName === 'whitelist' ? '白名单' : '黑名单';
    const input = new TextInputBuilder()
        .setCustomId('channel_id')
        .setLabel('频道 ID')
        .setPlaceholder('请输入频道 ID')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    return new ModalBuilder()
        .setCustomId(`${CHANNEL_ACCESS_MODAL_ID_PREFIX}${action}_${listName}`)
        .setTitle(`${operationLabel}${listLabel}频道`)
        .addComponents(new ActionRowBuilder().addComponents(input));
}

function accessListLabel(listName) {
    return listName === 'whitelist' ? '白名单' : '黑名单';
}

function defaultFetchChannel(interaction, channelId) {
    if (!interaction.guild?.channels?.fetch) {
        throw new Error('Guild channel fetch is unavailable');
    }
    return interaction.guild.channels.fetch(channelId);
}

async function safePrivateResponse(interaction, payload) {
    if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
        await interaction.editReply(payload);
        return;
    }
    if (interaction.replied && typeof interaction.followUp === 'function') {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        return;
    }
    if (typeof interaction.reply === 'function') {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
}

function createChannelAccessManager({
    store = defaultStore,
    fetchChannel = defaultFetchChannel,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
} = {}) {
    let loadPromise;

    function ensureLoaded() {
        if (!loadPromise) loadPromise = store.load();
        return loadPromise;
    }

    async function requirePermission(interaction) {
        if (checkPermission(interaction.member)) return true;
        await safePrivateResponse(interaction, { content: permissionDeniedMessage() });
        return false;
    }

    async function openChannelAccessManager(interaction) {
        if (!await requirePermission(interaction)) return;
        try {
            await ensureLoaded();
            await interaction.reply({
                ...panelPayload(store.getGuildConfig(interaction.guildId)),
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error('[MysteryChannelAccess] 打开管理面板失败:', error);
            await safePrivateResponse(interaction, { content: FAILURE_MESSAGE });
        }
    }

    async function labelChannel(interaction, channelId) {
        try {
            const channel = await fetchChannel(interaction, channelId);
            if (!channel || !channel.name) return `未知/已删除（${channelId}）`;
            return `#${channel.name}（${channelId}）`;
        } catch (error) {
            return `未知/已删除（${channelId}）`;
        }
    }

    function configurationDescriptions(whitelist, blacklist) {
        const descriptions = [];
        let current = '';

        function flush() {
            if (current) descriptions.push(current);
            current = '';
        }

        function appendLine(line, continuationHeader) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= CONFIG_DESCRIPTION_LIMIT) {
                current = candidate;
                return;
            }

            flush();
            current = continuationHeader;
            const continued = `${current}\n${line}`;
            if (continued.length <= CONFIG_DESCRIPTION_LIMIT) {
                current = continued;
                return;
            }

            let remaining = line;
            while (remaining) {
                const prefix = current ? `${current}\n` : '';
                const available = CONFIG_DESCRIPTION_LIMIT - prefix.length;
                current = `${prefix}${remaining.slice(0, available)}`;
                remaining = remaining.slice(available);
                if (remaining) {
                    flush();
                    current = continuationHeader;
                }
            }
        }

        function appendSection(label, entries) {
            const header = `**${label}（${entries.length}）**`;
            const continuationHeader = `**${label}（续）**`;
            const sectionStart = current ? `${current}\n\n${header}` : header;
            if (sectionStart.length <= CONFIG_DESCRIPTION_LIMIT) {
                current = sectionStart;
            } else {
                flush();
                current = header;
            }
            for (const entry of entries.length ? entries : ['（无）']) {
                appendLine(entry, continuationHeader);
            }
        }

        appendSection('白名单', whitelist);
        appendSection('黑名单', blacklist);
        flush();
        return descriptions;
    }

    async function showConfiguration(interaction) {
        await ensureLoaded();
        const config = store.getGuildConfig(interaction.guildId);
        const [whitelist, blacklist] = await Promise.all([
            Promise.all(config.whitelist.map(channelId => labelChannel(interaction, channelId))),
            Promise.all(config.blacklist.map(channelId => labelChannel(interaction, channelId))),
        ]);
        const descriptions = configurationDescriptions(whitelist, blacklist);
        const payloads = descriptions.map((description, index) => ({
            embeds: [new EmbedBuilder()
                .setTitle(descriptions.length === 1
                    ? '📋 神秘频道配置'
                    : `📋 神秘频道配置（${index + 1}/${descriptions.length}）`)
                .setDescription(description)],
        }));

        await interaction.editReply(payloads[0]);
        for (const payload of payloads.slice(1)) {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        }
    }

    async function addChannel(interaction, listName, channelId) {
        if (!CHANNEL_ID_PATTERN.test(channelId)) {
            await safePrivateResponse(interaction, { content: '❌ 频道 ID 必须是 5 至 32 位数字。' });
            return;
        }

        let channel;
        try {
            channel = await fetchChannel(interaction, channelId);
        } catch (error) {
            await safePrivateResponse(interaction, { content: '❌ 未找到该频道或无法访问该频道。' });
            return;
        }
        if (!channel || channel.guildId !== interaction.guildId) {
            await safePrivateResponse(interaction, { content: '❌ 只能添加当前服务器中的频道。' });
            return;
        }

        const config = store.getGuildConfig(interaction.guildId);
        const oppositeListName = listName === 'whitelist' ? 'blacklist' : 'whitelist';
        if (config[oppositeListName].includes(channelId)) {
            await safePrivateResponse(interaction, {
                content: `❌ 该频道已在${accessListLabel(oppositeListName)}中，不能同时加入${accessListLabel(listName)}。`,
            });
            return;
        }

        const added = await store.add(interaction.guildId, listName, channelId);
        await safePrivateResponse(interaction, {
            content: added
                ? `✅ 已将频道 ${channelId} 添加到${accessListLabel(listName)}。`
                : `⚠️ 该频道已在${accessListLabel(listName)}中。`,
        });
    }

    async function removeChannel(interaction, listName, channelId) {
        if (!CHANNEL_ID_PATTERN.test(channelId)) {
            await safePrivateResponse(interaction, { content: '❌ 频道 ID 必须是 5 至 32 位数字。' });
            return;
        }
        const removed = await store.remove(interaction.guildId, listName, channelId);
        await safePrivateResponse(interaction, {
            content: removed
                ? `✅ 已移除${accessListLabel(listName)}中的频道 ${channelId}。`
                : `⚠️ 该频道不在${accessListLabel(listName)}中。`,
        });
    }

    async function handleChannelAccessInteraction(interaction) {
        const customId = interaction?.customId;
        if (
            typeof customId !== 'string'
            || (!customId.startsWith(CHANNEL_ACCESS_CUSTOM_ID_PREFIX)
                && !customId.startsWith(CHANNEL_ACCESS_MODAL_ID_PREFIX))
        ) {
            return false;
        }
        if (!await requirePermission(interaction)) return true;

        try {
            if (interaction.isButton?.() && customId === `${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}view`) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await showConfiguration(interaction);
                return true;
            }

            await ensureLoaded();

            const buttonMatch = /^mystery_manage:channel_access:(add|remove)_(whitelist|blacklist)$/.exec(customId);
            if (interaction.isButton?.() && buttonMatch) {
                await interaction.showModal(createChannelModal(buttonMatch[1], buttonMatch[2]));
                return true;
            }

            const modalMatch = /^mystery_manage:channel_access_modal:(add|remove)_(whitelist|blacklist)$/.exec(customId);
            if (interaction.isModalSubmit?.() && modalMatch) {
                const channelId = interaction.fields.getTextInputValue('channel_id').trim();
                if (modalMatch[1] === 'add') {
                    await addChannel(interaction, modalMatch[2], channelId);
                } else {
                    await removeChannel(interaction, modalMatch[2], channelId);
                }
                return true;
            }

            await safePrivateResponse(interaction, { content: EXPIRED_MESSAGE });
            return true;
        } catch (error) {
            console.error(`[MysteryChannelAccess] 处理交互失败 (customId=${customId}):`, error);
            await safePrivateResponse(interaction, { content: FAILURE_MESSAGE });
            return true;
        }
    }

    return { openChannelAccessManager, handleChannelAccessInteraction };
}

const defaultManager = createChannelAccessManager();

module.exports = {
    CHANNEL_ACCESS_CUSTOM_ID_PREFIX,
    CHANNEL_ACCESS_MODAL_ID_PREFIX,
    CHANNEL_ID_PATTERN,
    createChannelAccessManager,
    openChannelAccessManager: defaultManager.openChannelAccessManager,
    handleChannelAccessInteraction: defaultManager.handleChannelAccessInteraction,
};
