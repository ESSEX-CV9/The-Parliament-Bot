const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { defaultChannelAccessStore, MAX_COOLDOWN_MS } = require('../utils/channelAccessStore');
const { MYSTERY_GAME_NAMES } = require('../utils/mysteryGames');
const {
    SETTING_LEVELS,
    SETTING_LEVEL_LABELS,
    resolveMysterySettings,
    levelOfChannel,
    formatCooldown,
    describeSource,
} = require('../services/channelAccessService');

const MAX_COOLDOWN_MINUTES = Math.floor(MAX_COOLDOWN_MS / 60000);
const INHERIT_MINUTES = -1;

const SUB_VIEW = '查看';
const SUB_ALLOW = '允许';
const SUB_COOLDOWN = '冷却';
const SUB_CLEAR = '清除';

const ALLOW_YES = '是';
const ALLOW_NO = '否';
const ALLOW_INHERIT = '继承';

const GENERIC_FAILURE_MESSAGE = '❌ 处理频道设置时出现错误，请稍后重试。';

function buildData() {
    const gameChoices = MYSTERY_GAME_NAMES.map(name => ({ name, value: name }));

    return new SlashCommandBuilder()
        .setName('神秘指令设置')
        .setDescription('调整本频道 / 子区的神秘指令开关与冷却')
        .addSubcommand(subcommand => subcommand
            .setName(SUB_VIEW)
            .setDescription('查看本频道当前生效的设置和继承来源'))
        .addSubcommand(subcommand => subcommand
            .setName(SUB_ALLOW)
            .setDescription('设置本频道是否允许使用神秘指令')
            .addStringOption(option => option
                .setName('状态')
                .setDescription('允许 / 禁止 / 继承上一层')
                .setRequired(true)
                .addChoices(
                    { name: ALLOW_YES, value: ALLOW_YES },
                    { name: ALLOW_NO, value: ALLOW_NO },
                    { name: ALLOW_INHERIT, value: ALLOW_INHERIT },
                )))
        .addSubcommand(subcommand => subcommand
            .setName(SUB_COOLDOWN)
            .setDescription('设置本频道的冷却时长')
            .addIntegerOption(option => option
                .setName('分钟')
                .setDescription(`0 = 无冷却，${INHERIT_MINUTES} = 继承上一层`)
                .setRequired(true)
                .setMinValue(INHERIT_MINUTES)
                .setMaxValue(MAX_COOLDOWN_MINUTES))
            .addStringOption(option => option
                .setName('游戏')
                .setDescription('只改这一个游戏的冷却；留空则设置本层的统一冷却')
                .setRequired(false)
                .addChoices(...gameChoices)))
        .addSubcommand(subcommand => subcommand
            .setName(SUB_CLEAR)
            .setDescription('清除本频道的全部覆盖，完全回到继承上一层'));
}

/**
 * 谁能改这一层：
 * - 管理员：任何频道、任何层
 * - 子区发起人 / 论坛帖主：只能改自己那个子区、帖子
 */
function resolveEditTarget(interaction, checkPermission = checkAdminPermission) {
    const channel = interaction.channel;
    const level = levelOfChannel(channel);

    if (!channel || !level) {
        return { allowed: false, reason: '❌ 无法识别当前频道。' };
    }
    if (checkPermission(interaction.member)) {
        return { allowed: true, channel, level };
    }
    if (level === SETTING_LEVELS.THREAD && channel.ownerId === interaction.user.id) {
        return { allowed: true, channel, level };
    }
    return {
        allowed: false,
        reason: level === SETTING_LEVELS.THREAD
            ? '❌ 只有本子区/帖子的发起人或管理员才能修改这里的设置。'
            : '❌ 只有管理员才能修改频道层的设置。请到子区或论坛帖子里使用，或联系管理员。',
    };
}

function describeEffective(settings, channel) {
    const lines = [];
    const allowedSource = settings.allowedSource;
    lines.push(`**当前频道：** ${channel ? `<#${channel.id}>` : '未知'}`);
    lines.push(
        settings.allowed
            ? `**是否允许：** ✅ 允许　(来自 ${describeSource(allowedSource)})`
            : `**是否允许：** 🚫 禁止　(来自 ${describeSource(allowedSource)})`
    );

    lines.push('', '**各游戏冷却：**');
    for (const gameName of MYSTERY_GAME_NAMES) {
        const { cooldownMs, source, perGame } = settings.cooldownFor(gameName);
        const origin = perGame ? `${describeSource(source)} 的单独设置` : describeSource(source);
        lines.push(`· ${gameName}：${formatCooldown(cooldownMs)}　(来自 ${origin})`);
    }

    const configured = settings.levels.filter(entry => entry.level !== SETTING_LEVELS.GUILD && entry.configured);
    lines.push('', '**继承链：**');
    for (const entry of settings.levels) {
        const label = entry.level === SETTING_LEVELS.GUILD
            ? SETTING_LEVEL_LABELS[SETTING_LEVELS.GUILD]
            : `${SETTING_LEVEL_LABELS[entry.level]} <#${entry.channelId}>`;
        const mark = entry.level === SETTING_LEVELS.GUILD || entry.configured ? '●' : '○';
        lines.push(`${mark} ${label}${entry.level !== SETTING_LEVELS.GUILD && !entry.configured ? '（未设置）' : ''}`);
    }
    if (configured.length === 0) {
        lines.push('', '_本频道和上级频道都没有覆盖设置，当前完全走服务器默认。_');
    }

    return lines.join('\n');
}

function createMysterySettingsCommand({
    store = defaultChannelAccessStore,
    checkPermission = checkAdminPermission,
} = {}) {
    const data = buildData();

    async function replyEffective(interaction, header) {
        const settings = resolveMysterySettings(
            interaction.channel,
            store.getGuildConfig(interaction.guildId),
        );
        const content = header
            ? `${header}\n\n${describeEffective(settings, interaction.channel)}`
            : describeEffective(settings, interaction.channel);
        await interaction.editReply({ content });
    }

    async function handleAllow(interaction, target) {
        const state = interaction.options.getString('状态');
        const allowed = state === ALLOW_YES ? true : state === ALLOW_NO ? false : null;

        const saved = await store.setOverride(interaction.guildId, target.channel.id, { allowed });
        const label = allowed === null
            ? '已改为继承上一层'
            : allowed ? '已设为 ✅ 允许' : '已设为 🚫 禁止';
        await replyEffective(
            interaction,
            saved || allowed !== null
                ? `✅ **本${SETTING_LEVEL_LABELS[target.level]}的「是否允许」${label}。**`
                : `✅ **本${SETTING_LEVEL_LABELS[target.level]}已没有任何覆盖，完全回到继承状态。**`
        );
    }

    async function handleCooldown(interaction, target) {
        const minutes = interaction.options.getInteger('分钟');
        const gameName = interaction.options.getString('游戏');
        const cooldownMs = minutes === INHERIT_MINUTES ? null : minutes * 60000;

        const patch = gameName
            ? { gameCooldownMs: { [gameName]: cooldownMs } }
            : { cooldownMs };
        await store.setOverride(interaction.guildId, target.channel.id, patch);

        const scope = gameName ? `「${gameName}」的冷却` : '统一冷却';
        const value = cooldownMs === null ? '已改为继承上一层' : `已设为 ${formatCooldown(cooldownMs)}`;
        await replyEffective(
            interaction,
            `✅ **本${SETTING_LEVEL_LABELS[target.level]}的${scope}${value}。**`
        );
    }

    async function handleClear(interaction, target) {
        const removed = await store.clearOverride(interaction.guildId, target.channel.id);
        await replyEffective(
            interaction,
            removed
                ? `✅ **已清除本${SETTING_LEVEL_LABELS[target.level]}的全部覆盖，回到继承上一层。**`
                : `ℹ️ 本${SETTING_LEVEL_LABELS[target.level]}本来就没有覆盖设置。`
        );
    }

    async function execute(interaction) {
        try {
            if (!interaction.inGuild()) {
                await interaction.reply({ content: '❌ 此指令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
                return;
            }

            const subcommand = interaction.options.getSubcommand(false);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await store.ensureLoaded();

            // 查看是只读的，任何人都可以看；改动才需要权限。
            if (subcommand === SUB_VIEW) {
                await replyEffective(interaction, null);
                return;
            }

            const target = resolveEditTarget(interaction, checkPermission);
            if (!target.allowed) {
                await interaction.editReply({ content: target.reason });
                return;
            }

            if (subcommand === SUB_ALLOW) {
                await handleAllow(interaction, target);
                return;
            }
            if (subcommand === SUB_COOLDOWN) {
                await handleCooldown(interaction, target);
                return;
            }
            if (subcommand === SUB_CLEAR) {
                await handleClear(interaction, target);
                return;
            }

            await interaction.editReply({ content: '❌ 未知的操作。' });
        } catch (error) {
            console.error(
                `[MysterySettings] 执行失败 (guild=${interaction.guildId}, channel=${interaction.channelId}, user=${interaction.user?.id}):`,
                error
            );
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: GENERIC_FAILURE_MESSAGE });
                } else {
                    await interaction.reply({ content: GENERIC_FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
                }
            } catch (replyError) {
                console.error('[MysterySettings] 回复异常提示失败:', replyError);
            }
        }
    }

    return { data, execute };
}

const command = createMysterySettingsCommand();

module.exports = {
    ...command,
    createMysterySettingsCommand,
    resolveEditTarget,
    describeEffective,
};
