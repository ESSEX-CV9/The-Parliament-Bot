const { MessageFlags } = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { getExportService, describeError } = require('../services/exportService');

const STATES = { queued: '等待中', running: '运行中', finalizing: '生成并校验文件中', completed: '已完成', failed: '失败', expired: '已过期' };
const SNAPSHOT_NOTICE = 'Discord 分页接口不提供原子快照；导出期间加入或离开的成员可能影响结果，唯一 ID 数量不等于某一时刻的全服人数。';

function createMemberIdsCommand({
    getService = getExportService,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
} = {}) {
    async function authorized(interaction) {
        try {
            // 刷新 owner、角色权限及单个调用者；绝不全量 fetch 成员。
            const guild = await interaction.guild.fetch();
            await guild.roles.fetch();
            const member = await guild.members.fetch({ user: interaction.user.id, force: true, cache: false });
            return checkPermission(member);
        } catch (_) { return false; }
    }

    return async function executeMemberIds(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!await authorized(interaction)) {
            return interaction.editReply({ content: permissionDeniedMessage() });
        }

        try {
            const service = getService(interaction.client);
            const guildId = interaction.guild.id;
            switch (interaction.options.getSubcommand()) {
                case '检查': {
                    const result = await service.check(guildId);
                    return interaction.editReply({ content: [
                        `GuildMembers Intent 本地配置：${result.intentConfigured ? '已启用' : '未启用'}`,
                        `官方成员列表 REST 实测：${result.restAccessible ? '可访问（仅请求 1 名成员）' : '失败'}`,
                        result.error || '',
                        `服务器人数估计：${result.estimate ?? '不可用'}${result.estimate !== null ? '（Discord approximate_member_count，非精确快照）' : ''}`,
                        result.estimateError ? `人数估计获取失败：${result.estimateError}` : '',
                        '代码中启用 Intent 不代表开发者后台已经批准；请结合本次 REST 实测和后台 Server Members Intent 设置确认。',
                        '检查未执行全量导出。',
                    ].filter(Boolean).join('\n') });
                }
                case '开始': {
                    const job = service.create(guildId);
                    await interaction.editReply({ content: [
                        `成员 ID 导出任务：\`${job.id}\``,
                        `当前状态：${STATES[job.status] || job.status}；已获取唯一 ID：${job.count || 0}`,
                        '任务已持久化。已有活动任务会复用；失败任务会从已提交断点续传。使用 `/管理 成员id 状态` 查询，完成后使用 `/管理 成员id 下载`。',
                        SNAPSHOT_NOTICE,
                    ].join('\n') });
                    service.kick();
                    return;
                }
                case '状态': {
                    const job = service.latest(guildId);
                    if (!job) return interaction.editReply({ content: '当前服务器没有成员 ID 导出任务（历史结果可能已自动清理）。' });
                    return interaction.editReply({ content: [
                        `任务 ID：\`${job.id}\``,
                        `状态：${STATES[job.status] || job.status}`,
                        `已获取唯一 ID：${job.count}；已完成非空分页：${job.pages}`,
                        `最近进度更新：<t:${Math.floor(job.updatedAt / 1000)}:F>`,
                        `累计应用层重试：${job.retries}（discord.js 内部限流等待未计入）`,
                        job.nextRetryAt ? `下次重试：<t:${Math.floor(job.nextRetryAt / 1000)}:R>` : '',
                        job.lastError ? `最近错误：${job.lastError}` : '',
                        job.status === 'completed' ? `实际导出：${job.count} 个唯一 ID；SHA-256：\`${job.artifact.sha256}\`` : '',
                        SNAPSHOT_NOTICE,
                    ].filter(Boolean).join('\n') });
                }
                case '下载': {
                    const limit = Number.isSafeInteger(interaction.attachmentSizeLimit)
                        ? interaction.attachmentSizeLimit : 8 * 1024 * 1024;
                    const result = await service.download(guildId, limit);
                    try {
                        for (let index = 0; index < result.files.length; index++) {
                            // 文件校验/分片期间权限可能变化；每次交付前重新获取。
                            if (!await authorized(interaction)) {
                                return interaction.editReply({ content: permissionDeniedMessage(), attachments: [] });
                            }
                            result.assertValid();
                            const payload = {
                                content: `任务 \`${result.job.id}\`：${result.job.count} 个唯一 ID；文件 ${index + 1}/${result.files.length}。\n${SNAPSHOT_NOTICE}`,
                                files: [result.files[index]], allowedMentions: { parse: [] },
                            };
                            if (index === 0) await interaction.editReply(payload);
                            else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
                        }
                    } finally { await result.release(); }
                    return;
                }
                default:
                    return interaction.editReply({ content: '❌ 未知的成员 ID 操作。' });
            }
        } catch (error) {
            return interaction.editReply({ content: `❌ 成员 ID 操作失败：${describeError(error)}`, attachments: [] });
        }
    };
}

module.exports = { createMemberIdsCommand, executeMemberIds: createMemberIdsCommand() };
