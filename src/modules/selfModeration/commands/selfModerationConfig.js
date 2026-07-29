// src/modules/selfModeration/commands/selfModerationConfig.js
//
// 由原先 8 个独立配置指令合并而来（省下 7 个指令名额）：
//   /搬石公投-设置自助管理权限        → /搬石公投配置 权限 ...
//   /搬石公投-设置自助管理频道        → /搬石公投配置 频道 ...
//   /搬石公投-设置自助管理冷却        → /搬石公投配置 冷却 ...
//   /搬石公投-设置消息时间限制        → /搬石公投配置 消息时间限制 ...
//   /搬石公投-设置归档频道            → /搬石公投配置 归档频道 ...
//   /搬石公投-设置归档查看身份组      → /搬石公投配置 归档查看身份组 ...
//   /搬石公投-管理附件清理            → /搬石公投配置 附件清理 ...
//   /搬石公投-管理自助管理黑名单      → /搬石公投配置 黑名单 ...
//
// 注意：/搬石公投-查看我的冷却 **没有**并进来。它面向普通成员（自查冷却状态、无权限检查），
// 而本指令是管理员专属；Discord 的 default_member_permissions 只能设在顶层指令上，
// 混在一起就只能靠代码补判定，边界反而模糊 —— 与 /风纪配置 曾经踩过的坑相同。
//
// 子指令组的 schema 直接从原指令的 builder 派生（见 buildGroupFrom），
// 保证选项名、描述、类型、必填性与合并前逐字段一致，处理逻辑也仍走原模块的 execute。
const { SlashCommandBuilder, MessageFlags, ApplicationCommandOptionType } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const SOURCES = [
    { group: '权限', description: '设置哪些身份组可以使用自助管理功能', module: require('./setSelfModerationRoles') },
    { group: '频道', description: '设置哪些频道可以使用自助管理功能', module: require('./setSelfModerationChannels') },
    { group: '冷却', description: '设置所有用户使用自助管理功能的全局冷却时间', module: require('./setSelfModerationCooldown') },
    { group: '消息时间限制', description: '设置可以投票的消息的时间限制', module: require('./setMessageTimeLimit') },
    { group: '归档频道', description: '设置被删除消息的归档频道', module: require('./setArchiveChannel') },
    { group: '归档查看身份组', description: '设置可以查看归档频道的身份组', module: require('./setArchiveViewRole') },
    { group: '附件清理', description: '管理附件清理任务', module: require('./manageAttachmentCleanup') },
    { group: '黑名单', description: '管理自助管理功能的用户黑名单', module: require('./manageSelfModerationBlacklist') },
];

/**
 * 按原始 JSON 还原一个选项，保持类型/必填/choices/频道类型/取值范围不变
 */
function applyOption(builder, raw) {
    const common = (opt) => {
        opt.setName(raw.name).setDescription(raw.description);
        if (raw.required) opt.setRequired(true);
        return opt;
    };

    switch (raw.type) {
        case ApplicationCommandOptionType.String:
            return builder.addStringOption(opt => {
                common(opt);
                if (raw.choices?.length) opt.addChoices(...raw.choices);
                if (raw.min_length != null) opt.setMinLength(raw.min_length);
                if (raw.max_length != null) opt.setMaxLength(raw.max_length);
                if (raw.autocomplete) opt.setAutocomplete(true);
                return opt;
            });
        case ApplicationCommandOptionType.Integer:
            return builder.addIntegerOption(opt => {
                common(opt);
                if (raw.choices?.length) opt.addChoices(...raw.choices);
                if (raw.min_value != null) opt.setMinValue(raw.min_value);
                if (raw.max_value != null) opt.setMaxValue(raw.max_value);
                if (raw.autocomplete) opt.setAutocomplete(true);
                return opt;
            });
        case ApplicationCommandOptionType.Number:
            return builder.addNumberOption(opt => {
                common(opt);
                if (raw.choices?.length) opt.addChoices(...raw.choices);
                if (raw.min_value != null) opt.setMinValue(raw.min_value);
                if (raw.max_value != null) opt.setMaxValue(raw.max_value);
                return opt;
            });
        case ApplicationCommandOptionType.Boolean:
            return builder.addBooleanOption(opt => common(opt));
        case ApplicationCommandOptionType.User:
            return builder.addUserOption(opt => common(opt));
        case ApplicationCommandOptionType.Role:
            return builder.addRoleOption(opt => common(opt));
        case ApplicationCommandOptionType.Mentionable:
            return builder.addMentionableOption(opt => common(opt));
        case ApplicationCommandOptionType.Channel:
            return builder.addChannelOption(opt => {
                common(opt);
                if (raw.channel_types?.length) opt.addChannelTypes(...raw.channel_types);
                return opt;
            });
        case ApplicationCommandOptionType.Attachment:
            return builder.addAttachmentOption(opt => common(opt));
        default:
            throw new Error(`[SelfModerationConfig] 不支持的选项类型: ${raw.type}（选项 ${raw.name}）`);
    }
}

/**
 * 把某个原指令的全部子指令，原样搬进一个子指令组
 */
function buildGroupFrom(group, source) {
    const json = source.module.data.toJSON();
    group.setName(source.group).setDescription(source.description);

    for (const sub of json.options || []) {
        if (sub.type !== ApplicationCommandOptionType.Subcommand) {
            throw new Error(`[SelfModerationConfig] ${json.name} 含非子指令的顶层选项「${sub.name}」，无法并入子指令组`);
        }
        group.addSubcommand(s => {
            s.setName(sub.name).setDescription(sub.description);
            for (const opt of sub.options || []) applyOption(s, opt);
            return s;
        });
    }

    return group;
}

const data = new SlashCommandBuilder()
    .setName('搬石公投配置')
    .setDescription('自助管理（搬石公投）系统的全部配置项')
    .setDefaultMemberPermissions(0);

for (const source of SOURCES) {
    data.addSubcommandGroup(group => buildGroupFrom(group, source));
}

const GROUP_TO_MODULE = new Map(SOURCES.map(s => [s.group, s.module]));

async function execute(interaction) {
    const group = interaction.options.getSubcommandGroup();

    try {
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral,
            });
        }

        // 统一在这里做管理员校验：合并前 7 个子模块本就各自做这件事，
        // 只有「附件清理」原先仅靠 Discord 的 ManageGuild 权限把关，现在与其余项对齐。
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral,
            });
        }

        const module = GROUP_TO_MODULE.get(group);
        if (!module) {
            return interaction.reply({
                content: '❌ 未知的配置分组。',
                flags: MessageFlags.Ephemeral,
            });
        }

        // 各子模块的 execute 自行 defer / 回复，行为与合并前完全一致
        await module.execute(interaction);
    } catch (error) {
        console.error(`[SelfModerationConfig] /搬石公投配置 ${group} 执行出错:`, error);
        const content = `❌ 执行出错：${error.message}`;
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content });
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral });
            }
        } catch (replyError) {
            console.error('[SelfModerationConfig] 回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};
