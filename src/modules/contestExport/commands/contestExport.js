// src/modules/contestExport/commands/contestExport.js
// /管理 赛事 导出：仅限指定身份组，私密返回本服务器赛事与投稿的只读 JSON 快照。
const zlib = require('zlib');
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { buildContestExport } = require('../services/exportBuilder');
const { parseMapping, publishPanels } = require('../services/panelPublisher');

// 延迟加载数据层：contestDatabase 在加载时会初始化 data 目录，测试中不应触发。
const contestDatabase = () => require('../../contest/utils/contestDatabase');

// 可用环境变量 CONTEST_EXPORT_ROLE_IDS（逗号分隔）覆盖；默认只允许该身份组使用。
const DEFAULT_EXPORT_ROLE_IDS = ['1289224017789583453'];

function getExportRoleIds(env = process.env) {
    const ids = String(env.CONTEST_EXPORT_ROLE_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    return ids.length ? ids : DEFAULT_EXPORT_ROLE_IDS;
}

function hasExportRole(member, roleIds) {
    return typeof member?.roles?.cache?.has === 'function' && roleIds.some(id => member.roles.cache.has(id));
}

function createContestExportCommand({
    readChannels = () => contestDatabase().getAllContestChannels(),
    readSubmissions = () => contestDatabase().getAllContestSubmissions(),
    roleIds = getExportRoleIds(),
    now = () => new Date(),
    downloadText = async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`下载对照表失败（HTTP ${response.status}）`);
        return response.text();
    },
    readContest = async id => contestDatabase().getAllContestChannels()[id] || null,
    readContestSubmissions = async id => contestDatabase().getSubmissionsByChannel(id),
    publish = publishPanels,
} = {}) {
    async function runPanels(interaction) {
        const file = interaction.options.getAttachment('对照表', true);
        if (file.size > 1024 * 1024) {
            return interaction.editReply({ content: '❌ 对照表文件过大（上限 1MB）。' });
        }
        let entries;
        try {
            entries = parseMapping(await downloadText(file.url));
        } catch (error) {
            return interaction.editReply({ content: `❌ ${error.message}` });
        }
        console.log(`[ContestExport] 发布归档面板 guild=${interaction.guild.id} operator=${interaction.user.id} entries=${entries.length}`);
        await interaction.editReply({ content: `开始发布投稿面板：共 ${entries.length} 个帖子……` });

        const result = await publish(entries, {
            guild: interaction.guild,
            botId: interaction.client.user.id,
            fetchChannel: id => interaction.client.channels.fetch(id),
            readContest,
            readSubmissions: readContestSubmissions,
            onProgress: async (done, total) => {
                if (done % 10 === 0 && done < total) {
                    await interaction.editReply({ content: `发布投稿面板中：${done} / ${total}` });
                }
            },
        });

        const lines = [
            `投稿面板发布完成：已发 ${result.sent.length}，跳过 ${result.skipped.length}（已有面板），失败 ${result.failed.length}。`,
            ...result.failed.slice(0, 15).map(item => `- 帖子 ${item.threadId}：${item.reason}`),
            result.failed.length > 15 ? `……另有 ${result.failed.length - 15} 个失败` : null,
        ].filter(Boolean);
        return interaction.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
    }

    async function authorized(interaction) {
        try {
            // 强制刷新调用者，避免缓存里过期的身份组放行。
            const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true, cache: false });
            return hasExportRole(member, roleIds);
        } catch (_) { return false; }
    }

    return async function executeContestExport(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!await authorized(interaction)) {
            return interaction.editReply({ content: '❌ 你没有导出赛事数据的权限。' });
        }
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand === '归档面板') {
            return runPanels(interaction);
        }
        if (subcommand !== '导出') {
            return interaction.editReply({ content: '❌ 未知的赛事操作。' });
        }

        try {
            const guildId = interaction.guild.id;
            const time = now();
            const data = buildContestExport(await readChannels(), await readSubmissions(), guildId, time);
            const limit = Number.isSafeInteger(interaction.attachmentSizeLimit)
                ? interaction.attachmentSizeLimit : 8 * 1024 * 1024;
            let buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
            let name = `contest-export-${guildId}-${time.toISOString().slice(0, 10)}.json`;
            if (buffer.length > limit) {
                buffer = zlib.gzipSync(buffer);
                name += '.gz';
            }
            if (buffer.length > limit) {
                return interaction.editReply({ content: `❌ 导出文件过大（${buffer.length} 字节），超过附件上限。` });
            }
            console.log(`[ContestExport] guild=${guildId} operator=${interaction.user.id} contests=${data.stats.contests} submissions=${data.stats.submissions}`);
            return interaction.editReply({
                content: `赛事 ${data.stats.contests} 个，投稿 ${data.stats.submissions} 条（有效 ${data.stats.validSubmissions}）。仅包含本服务器赛事，为只读快照。`,
                files: [new AttachmentBuilder(buffer, { name })],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('[ContestExport] 导出失败:', error);
            return interaction.editReply({ content: `❌ 导出失败：${error.message}` });
        }
    };
}

module.exports = {
    createContestExportCommand,
    executeContestExport: createContestExportCommand(),
    getExportRoleIds,
    hasExportRole,
    DEFAULT_EXPORT_ROLE_IDS,
};
