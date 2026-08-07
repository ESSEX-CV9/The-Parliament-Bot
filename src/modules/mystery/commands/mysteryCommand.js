const {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require('discord.js');
const {
    isOnCooldown,
    startCooldown,
    acquireInFlight,
    releaseInFlight,
} = require('../utils/cooldown');

const SUBCOMMAND_SELF_TIMEOUT = '自刎归天';
const SUBCOMMAND_RANDOM_NICKNAME = '取名字好麻烦';
const SELF_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const SELF_TIMEOUT_REASON = '神秘指令：自刎归天';
const COOLDOWN_MESSAGE = '⏳ **这个神秘指令还在冷却中**， **30分钟后才能再次使用**。';
const TIMEOUT_FAILURE_MESSAGE = '❌ 神秘力量失效了，我无法对你施加禁言。\n可能是机器人权限或身份组层级不足。';
const NICKNAME_FAILURE_MESSAGE = '❌ 名字取好了，但我改不了你的昵称。\n可能是机器人权限或身份组层级不足。';
const GENERIC_FAILURE_MESSAGE = '❌ 处理神秘指令时出现错误，请稍后重试。';

const NAME_POOL = [
    '我是奶人', '奶奶的龙', '铁血旅程派', '铁血类脑派', '权蛆', 'D喵梦男', 'D喵梦女',
    '大狗叫！', '猪猪之王', '类脑自研文爱AI', '赛博街溜子', '名字被狗吃了',
    '管理组重点观察对象', '用户名涉嫌违规', '类脑最纯洁之人', '类脑最淫乱之人', '基米',
    '我不是gay', '我是好女孩吗', '类脑第一深情', '名字已被夺舍', '疑似真人',
    '别问我为什么叫这个', '嘉豪本豪', '我现在后悔还来得及吗', '嘉豪',
];

const data = new SlashCommandBuilder()
    .setName('神秘指令')
    .setDescription('触发一个神秘的娱乐效果')
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_SELF_TIMEOUT)
        .setDescription('让自己暂时归天五分钟'))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_RANDOM_NICKNAME)
        .setDescription('随机决定自己的服务器昵称'));

function botHasPermission(interaction, permission) {
    return interaction.guild.members.me?.permissions?.has(permission) === true;
}

function getPreflightFailure(interaction, subcommand) {
    const member = interaction.member;
    if (subcommand === SUBCOMMAND_SELF_TIMEOUT) {
        return botHasPermission(interaction, PermissionFlagsBits.ModerateMembers) && member?.moderatable
            ? null
            : TIMEOUT_FAILURE_MESSAGE;
    }
    return botHasPermission(interaction, PermissionFlagsBits.ManageNicknames) && member?.manageable
        ? null
        : NICKNAME_FAILURE_MESSAGE;
}

async function replacePublicDeferWithPrivateFailure(interaction, content) {
    try {
        await interaction.deleteReply();
    } catch (error) {
        console.error(`[Mystery] 删除公开等待面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return;
    }
    try {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error(`[Mystery] 发送私密失败面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
    }
}

async function replyWithUnexpectedError(interaction) {
    try {
        if (interaction.deferred) {
            await replacePublicDeferWithPrivateFailure(interaction, GENERIC_FAILURE_MESSAGE);
        } else {
            await interaction.reply({ content: GENERIC_FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
        }
    } catch (replyError) {
        console.error('[Mystery] 回复异常提示失败:', replyError);
    }
}

async function executeSelfTimeout(interaction) {
    try {
        await interaction.member.timeout(SELF_TIMEOUT_DURATION_MS, SELF_TIMEOUT_REASON);
    } catch (error) {
        console.error(`[Mystery] 自刎归天 Timeout 失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return null;
    }
    return {
        publicEmbed: new EmbedBuilder().setDescription(
            `⚰️ **他选择了结束这一切。**\n\n<@${interaction.user.id}> 已自刎归天，**5分钟后还魂**。`
        ),
        privateContent: '👻 **你已成功归天。**\n\n接下来的 **5分钟**，你将无法在服务器内正常发言。\n\n**5分钟后会自动还魂。**',
    };
}

function selectRandomNickname(currentDisplayName) {
    let selectedName = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    if (selectedName === currentDisplayName) {
        selectedName = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    }
    return selectedName;
}

async function executeRandomNickname(interaction) {
    const member = interaction.member;
    const selectedName = selectRandomNickname(member.displayName);
    try {
        await member.setNickname(selectedName);
    } catch (error) {
        console.error(`[Mystery] 修改昵称失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return null;
    }
    return {
        publicEmbed: new EmbedBuilder().setDescription(
            `📝 **看得出来你确实懒得取名字。**\n已替你决定：**「${selectedName}」**`
        ),
        privateContent: [
            '✏️ **不喜欢这个名字？**', '', '你可以随时把自己的服务器昵称改回来，本指令不会锁定你的昵称。', '',
            '**电脑 / 网页版**', '右键自己的头像或名字 → **编辑服务器个人资料** → 修改 **服务器昵称** → 保存', '',
            '**手机端**', '在服务器内点击自己的头像 → **编辑服务器个人资料** → 修改 **服务器昵称** → 保存', '',
            '本次改名不会自动恢复。',
        ].join('\n'),
    };
}

async function sendSuccessPanels(interaction, result) {
    try {
        await interaction.editReply({ embeds: [result.publicEmbed] });
    } catch (error) {
        console.error(`[Mystery] 发送公开面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        await replacePublicDeferWithPrivateFailure(interaction, result.privateContent);
        return;
    }
    try {
        await interaction.followUp({
            content: result.privateContent,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(`[Mystery] 发送私密面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
    }
}

async function execute(interaction) {
    let guildId = null;
    let userId = interaction.user?.id || 'unknown';
    let subcommand = null;
    let lockAcquired = false;
    try {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ 此指令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
            return;
        }
        subcommand = interaction.options.getSubcommand(false);
        const validSubcommands = [SUBCOMMAND_SELF_TIMEOUT, SUBCOMMAND_RANDOM_NICKNAME];
        if (!validSubcommands.includes(subcommand)) {
            await interaction.reply({ content: '❌ 未知的神秘指令。', flags: MessageFlags.Ephemeral });
            return;
        }
        guildId = interaction.guild.id;
        userId = interaction.user.id;
        if (isOnCooldown(guildId, userId, subcommand)) {
            await interaction.reply({ content: COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }
        lockAcquired = acquireInFlight(guildId, userId, subcommand);
        if (!lockAcquired) {
            await interaction.reply({ content: COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }
        const preflightFailure = getPreflightFailure(interaction, subcommand);
        if (preflightFailure) {
            await interaction.reply({ content: preflightFailure, flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        const result = subcommand === SUBCOMMAND_SELF_TIMEOUT
            ? await executeSelfTimeout(interaction)
            : await executeRandomNickname(interaction);
        if (!result) {
            const failureMessage = subcommand === SUBCOMMAND_SELF_TIMEOUT
                ? TIMEOUT_FAILURE_MESSAGE
                : NICKNAME_FAILURE_MESSAGE;
            await replacePublicDeferWithPrivateFailure(interaction, failureMessage);
            return;
        }
        startCooldown(guildId, userId, subcommand);
        await sendSuccessPanels(interaction, result);
    } catch (error) {
        console.error(
            `[Mystery] 执行指令失败 (guild=${guildId || interaction.guild?.id || 'dm'}, user=${userId}, subcommand=${subcommand || 'unknown'}):`,
            error
        );
        await replyWithUnexpectedError(interaction);
    } finally {
        if (lockAcquired) releaseInFlight(guildId, userId, subcommand);
    }
}

module.exports = { data, execute };
