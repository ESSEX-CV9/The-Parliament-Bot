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
const { defaultChannelAccessStore, MAX_COOLDOWN_MS } = require('../utils/channelAccessStore');
const { MYSTERY_GAME_NAMES, isMysteryGame } = require('../utils/mysteryGames');
const { formatCooldown } = require('./channelAccessService');

const CHANNEL_ACCESS_CUSTOM_ID_PREFIX = 'mystery_manage:channel_access:';
const CHANNEL_ACCESS_MODAL_ID_PREFIX = 'mystery_manage:channel_access_modal:';
const CHANNEL_ID_PATTERN = /^[0-9]{5,32}$/;
const CONFIG_DESCRIPTION_LIMIT = 3900;
const MAX_COOLDOWN_MINUTES = Math.floor(MAX_COOLDOWN_MS / 60000);
const EXPIRED_MESSAGE = '⚠️ 此频道设置交互已过期或无效。';
const FAILURE_MESSAGE = '❌ 处理频道设置时出现问题，请稍后再试。';
const INHERIT_TOKENS = new Set(['', '继承', '-', '默认', 'inherit']);
const TRUE_TOKENS = new Set(['是', '开', '允许', 'y', 'yes', 'true', 'on', '1']);
const FALSE_TOKENS = new Set(['否', '关', '禁止', 'n', 'no', 'false', 'off', '0']);

class SettingsInputError extends Error {}

/** 允许使用：是 / 否 / 留空表示继承（服务器默认层的「继承」即回落到内建默认）。 */
function parseAllowedInput(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (INHERIT_TOKENS.has(value)) return null;
    if (TRUE_TOKENS.has(value)) return true;
    if (FALSE_TOKENS.has(value)) return false;
    throw new SettingsInputError('「允许使用」请填 `是` 或 `否`，留空表示继承上一层。');
}

/** 冷却分钟数：0 表示无冷却，留空表示继承。 */
function parseCooldownInput(raw) {
    const value = String(raw ?? '').trim();
    if (INHERIT_TOKENS.has(value.toLowerCase())) return null;

    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_COOLDOWN_MINUTES) {
        throw new SettingsInputError(`「冷却」请填 0 到 ${MAX_COOLDOWN_MINUTES} 之间的分钟数（0 表示无冷却），留空表示继承上一层。`);
    }
    return Math.round(minutes * 60000);
}

/** 单独游戏冷却：`传炸弹=5,死斗=10`，留空表示本层不给任何游戏设专属冷却。 */
function parseGameCooldownInput(raw) {
    const value = String(raw ?? '').trim();
    if (value.length === 0) return {};

    const parsed = {};
    for (const segment of value.split(/[,，\n]/)) {
        const trimmed = segment.trim();
        if (trimmed.length === 0) continue;

        const separatorIndex = trimmed.search(/[=＝:：]/);
        if (separatorIndex <= 0) {
            throw new SettingsInputError(`无法解析「${trimmed}」，格式应为 \`游戏名=分钟\`，多个用逗号分隔。`);
        }
        const gameName = trimmed.slice(0, separatorIndex).trim();
        const minutesText = trimmed.slice(separatorIndex + 1).trim();

        if (!isMysteryGame(gameName)) {
            throw new SettingsInputError(`未知的游戏名「${gameName}」。可用：${MYSTERY_GAME_NAMES.join('、')}`);
        }
        const minutes = Number(minutesText);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_COOLDOWN_MINUTES) {
            throw new SettingsInputError(`「${gameName}」的分钟数必须在 0 到 ${MAX_COOLDOWN_MINUTES} 之间。`);
        }
        parsed[gameName] = Math.round(minutes * 60000);
    }
    return parsed;
}

/**
 * 弹窗提交的是该层的完整状态，所以本次没提到、但之前存在的游戏要显式置 null 清掉。
 */
function buildGameCooldownPatch(parsed, current = {}) {
    const patch = { ...parsed };
    for (const gameName of Object.keys(current)) {
        if (!Object.hasOwn(patch, gameName)) patch[gameName] = null;
    }
    return patch;
}

function formatGameCooldowns(gameCooldownMs) {
    const entries = Object.entries(gameCooldownMs || {});
    if (entries.length === 0) return '（无）';
    return entries.map(([gameName, ms]) => `${gameName} ${formatCooldown(ms)}`).join('、');
}

function gameCooldownInputValue(gameCooldownMs) {
    return Object.entries(gameCooldownMs || {})
        .map(([gameName, ms]) => `${gameName}=${Math.round(ms / 60000)}`)
        .join(',');
}

function describeOverride(override) {
    const parts = [];
    if (override.allowed === true) parts.push('✅ 允许');
    else if (override.allowed === false) parts.push('🚫 禁止');
    else parts.push('↑ 继承允许状态');

    parts.push(Number.isFinite(override.cooldownMs)
        ? `冷却 ${formatCooldown(override.cooldownMs)}`
        : '↑ 继承冷却');

    const gameCooldowns = Object.entries(override.gameCooldownMs || {});
    if (gameCooldowns.length > 0) {
        parts.push(`单独：${formatGameCooldowns(override.gameCooldownMs)}`);
    }
    return parts.join(' · ');
}

function panelPayload(guildConfig) {
    const { default: guildDefault, overrides } = guildConfig;
    const embed = new EmbedBuilder()
        .setTitle('🔧 神秘指令频道设置')
        .setDescription([
            '设置分三层，逐级向下覆盖，没设置的字段自动继承上一层：',
            '**服务器默认** → **文字频道/论坛** → **子区/论坛帖子**',
            '',
            '冷却解析时每一层先看该游戏的专属冷却，再看该层的统一冷却，第一个命中的生效。',
            '子区和论坛帖子那一层，发起人／帖主可以自己用 `/神秘指令设置` 调整。',
        ].join('\n'))
        .addFields(
            {
                name: '服务器默认',
                value: [
                    guildDefault.allowed ? '✅ 允许使用' : '🚫 禁止使用',
                    `统一冷却：${formatCooldown(guildDefault.cooldownMs)}`,
                    `单独游戏冷却：${formatGameCooldowns(guildDefault.gameCooldownMs)}`,
                ].join('\n'),
            },
            {
                name: '频道 / 子区覆盖',
                value: `共 **${Object.keys(overrides).length}** 条`,
            },
        );

    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}edit_default`)
            .setLabel('⚙️ 服务器默认')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}edit_override`)
            .setLabel('➕ 设置频道覆盖')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}clear_override`)
            .setLabel('🗑️ 移除频道覆盖')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${CHANNEL_ACCESS_CUSTOM_ID_PREFIX}view`)
            .setLabel('📋 查看全部')
            .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [controls] };
}

function shortInput(customId, label, { placeholder, value, required = false, maxLength = 120 }) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(required)
        .setMaxLength(maxLength);
    if (placeholder) input.setPlaceholder(placeholder);
    if (value) input.setValue(value);
    return new ActionRowBuilder().addComponents(input);
}

// 服务器默认层的字段预填当前值，提交什么就是什么。
function createDefaultModal(guildDefault) {
    return new ModalBuilder()
        .setCustomId(`${CHANNEL_ACCESS_MODAL_ID_PREFIX}default`)
        .setTitle('服务器默认设置')
        .addComponents(
            shortInput('allowed', '允许使用（是 / 否）', {
                placeholder: '是',
                value: guildDefault.allowed ? '是' : '否',
                required: true,
                maxLength: 8,
            }),
            shortInput('cooldown_minutes', '统一冷却（分钟，0 = 无冷却）', {
                placeholder: '30',
                value: String(Math.round(guildDefault.cooldownMs / 60000)),
                required: true,
                maxLength: 8,
            }),
            shortInput('game_cooldowns', '单独游戏冷却（留空表示不设）', {
                placeholder: '传炸弹=5,死斗=10',
                value: gameCooldownInputValue(guildDefault.gameCooldownMs),
                // 7 个游戏全填也放得下
                maxLength: 300,
            }),
        );
}

// 覆盖层的三个字段留空即表示「本层不覆盖，继承上一层」。
function createOverrideModal() {
    return new ModalBuilder()
        .setCustomId(`${CHANNEL_ACCESS_MODAL_ID_PREFIX}override`)
        .setTitle('设置频道 / 子区覆盖')
        .addComponents(
            shortInput('channel_id', '频道 / 子区 / 帖子 ID', {
                placeholder: '右键频道 → 复制频道 ID',
                required: true,
                maxLength: 32,
            }),
            shortInput('allowed', '允许使用（是 / 否，留空 = 继承）', { placeholder: '留空表示继承上一层' }),
            shortInput('cooldown_minutes', '统一冷却分钟（留空 = 继承）', { placeholder: '留空表示继承上一层' }),
            shortInput('game_cooldowns', '单独游戏冷却（留空 = 不设）', {
                placeholder: '传炸弹=5,死斗=10',
                maxLength: 300,
            }),
        );
}

function createClearModal() {
    return new ModalBuilder()
        .setCustomId(`${CHANNEL_ACCESS_MODAL_ID_PREFIX}clear`)
        .setTitle('移除频道覆盖')
        .addComponents(
            shortInput('channel_id', '频道 / 子区 / 帖子 ID', {
                placeholder: '移除后该频道回到继承状态',
                required: true,
                maxLength: 32,
            }),
        );
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

/** 把若干行按 embed 描述上限切成多段。 */
function chunkLines(lines) {
    const chunks = [];
    let current = '';
    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length <= CONFIG_DESCRIPTION_LIMIT) {
            current = candidate;
            continue;
        }
        if (current) chunks.push(current);
        current = line.slice(0, CONFIG_DESCRIPTION_LIMIT);
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ['（无）'];
}

function createChannelAccessManager({
    store = defaultChannelAccessStore,
    fetchChannel = defaultFetchChannel,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
} = {}) {
    async function requirePermission(interaction) {
        if (checkPermission(interaction.member)) return true;
        await safePrivateResponse(interaction, { content: permissionDeniedMessage() });
        return false;
    }

    async function openChannelAccessManager(interaction) {
        if (!await requirePermission(interaction)) return;
        try {
            await store.ensureLoaded();
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

    async function showConfiguration(interaction) {
        await store.ensureLoaded();
        const config = store.getGuildConfig(interaction.guildId);
        const entries = Object.entries(config.overrides);
        const labels = await Promise.all(
            entries.map(([channelId]) => labelChannel(interaction, channelId))
        );

        const lines = [
            '**服务器默认**',
            config.default.allowed ? '✅ 允许使用' : '🚫 禁止使用',
            `统一冷却：${formatCooldown(config.default.cooldownMs)}`,
            `单独游戏冷却：${formatGameCooldowns(config.default.gameCooldownMs)}`,
            '',
            `**频道 / 子区覆盖（${entries.length}）**`,
            ...(entries.length === 0
                ? ['（无）']
                : entries.map(([, override], index) => `${labels[index]}\n　${describeOverride(override)}`)),
        ];

        const chunks = chunkLines(lines);
        const payloads = chunks.map((description, index) => ({
            embeds: [new EmbedBuilder()
                .setTitle(chunks.length === 1
                    ? '📋 神秘指令频道配置'
                    : `📋 神秘指令频道配置（${index + 1}/${chunks.length}）`)
                .setDescription(description)],
        }));

        await interaction.editReply(payloads[0]);
        for (const payload of payloads.slice(1)) {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        }
    }

    async function submitDefault(interaction) {
        const current = store.getDefault(interaction.guildId);
        const allowed = parseAllowedInput(interaction.fields.getTextInputValue('allowed'));
        const cooldownMs = parseCooldownInput(interaction.fields.getTextInputValue('cooldown_minutes'));
        const gameCooldownMs = buildGameCooldownPatch(
            parseGameCooldownInput(interaction.fields.getTextInputValue('game_cooldowns')),
            current.gameCooldownMs
        );

        const saved = await store.setDefault(interaction.guildId, { allowed, cooldownMs, gameCooldownMs });
        if (!saved) {
            await safePrivateResponse(interaction, { content: FAILURE_MESSAGE });
            return;
        }
        await safePrivateResponse(interaction, {
            content: [
                '✅ **已更新服务器默认设置。**',
                saved.allowed ? '允许使用：是' : '允许使用：否',
                `统一冷却：${formatCooldown(saved.cooldownMs)}`,
                `单独游戏冷却：${formatGameCooldowns(saved.gameCooldownMs)}`,
            ].join('\n'),
        });
    }

    async function submitOverride(interaction) {
        const channelId = interaction.fields.getTextInputValue('channel_id').trim();
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
            await safePrivateResponse(interaction, { content: '❌ 只能设置当前服务器中的频道。' });
            return;
        }

        const current = store.getOverride(interaction.guildId, channelId) || {};
        const allowed = parseAllowedInput(interaction.fields.getTextInputValue('allowed'));
        const cooldownMs = parseCooldownInput(interaction.fields.getTextInputValue('cooldown_minutes'));
        const gameCooldownMs = buildGameCooldownPatch(
            parseGameCooldownInput(interaction.fields.getTextInputValue('game_cooldowns')),
            current.gameCooldownMs
        );

        const saved = await store.setOverride(interaction.guildId, channelId, {
            allowed,
            cooldownMs,
            gameCooldownMs,
        });
        await safePrivateResponse(interaction, {
            content: saved
                ? `✅ **已设置 <#${channelId}> 的覆盖。**\n${describeOverride(saved)}`
                : `✅ 三个字段都留空了，已移除 <#${channelId}> 的覆盖，该频道回到继承状态。`,
        });
    }

    async function submitClear(interaction) {
        const channelId = interaction.fields.getTextInputValue('channel_id').trim();
        if (!CHANNEL_ID_PATTERN.test(channelId)) {
            await safePrivateResponse(interaction, { content: '❌ 频道 ID 必须是 5 至 32 位数字。' });
            return;
        }
        const removed = await store.clearOverride(interaction.guildId, channelId);
        await safePrivateResponse(interaction, {
            content: removed
                ? `✅ 已移除 <#${channelId}> 的覆盖，该频道回到继承状态。`
                : `⚠️ <#${channelId}> 本来就没有覆盖设置。`,
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

            await store.ensureLoaded();

            if (interaction.isButton?.()) {
                const action = customId.slice(CHANNEL_ACCESS_CUSTOM_ID_PREFIX.length);
                if (action === 'edit_default') {
                    await interaction.showModal(createDefaultModal(store.getDefault(interaction.guildId)));
                    return true;
                }
                if (action === 'edit_override') {
                    await interaction.showModal(createOverrideModal());
                    return true;
                }
                if (action === 'clear_override') {
                    await interaction.showModal(createClearModal());
                    return true;
                }
            }

            if (interaction.isModalSubmit?.()) {
                const action = customId.slice(CHANNEL_ACCESS_MODAL_ID_PREFIX.length);
                if (action === 'default') {
                    await submitDefault(interaction);
                    return true;
                }
                if (action === 'override') {
                    await submitOverride(interaction);
                    return true;
                }
                if (action === 'clear') {
                    await submitClear(interaction);
                    return true;
                }
            }

            await safePrivateResponse(interaction, { content: EXPIRED_MESSAGE });
            return true;
        } catch (error) {
            if (error instanceof SettingsInputError) {
                await safePrivateResponse(interaction, { content: `❌ ${error.message}` });
                return true;
            }
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
    SettingsInputError,
    parseAllowedInput,
    parseCooldownInput,
    parseGameCooldownInput,
    buildGameCooldownPatch,
    createChannelAccessManager,
    openChannelAccessManager: defaultManager.openChannelAccessManager,
    handleChannelAccessInteraction: defaultManager.handleChannelAccessInteraction,
};
