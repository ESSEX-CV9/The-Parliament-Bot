const {
    SlashCommandBuilder,
    AttachmentBuilder,
} = require('discord.js');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { getRoleSyncDb, getRoleSyncSetting, setRoleSyncSetting } = require('../utils/roleSyncDatabase');
const {
    importPlanFile,
    previewImportJob,
    applyImportJob,
    exportGuildRolesCsv,
    exportLinkRolesCsv,
    getRoleSyncRuntimeStatus,
    listSnapshots,
    rollbackBySnapshot,
    reconcileSingleMember,
    reconcileBatch,
    reconcileFull,
    stopReconcile,
    isReconcileRunning,
    runAutoReconcileManual,
    getReconcileRuntimeStatus,
    setLinkEnabled,
    listSyncLinks,
    bootstrapMembersForLink,
    stopBootstrap,
} = require('../services/configCsvService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('身份组同步')
        .setDescription('身份组同步系统管理指令（CSV导入/预检/应用/导出）')
        .setDefaultMemberPermissions(0)
        .addSubcommand((sub) =>
            sub
                .setName('导出当前服务器角色')
                .setDescription('导出当前服务器角色快照为 CSV'))
        .addSubcommand((sub) =>
            sub
                .setName('导出链路角色')
                .setDescription('按 link_id 导出 source/target 两侧角色快照')
                .addStringOption((opt) =>
                    opt
                        .setName('link_id')
                        .setDescription('同步链路ID，例如 main_to_sub1')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('导入计划')
                .setDescription('导入角色同步计划 CSV/Excel 文件')
                .addAttachmentOption((opt) =>
                    opt
                        .setName('计划文件')
                        .setDescription('支持 .csv/.xlsx/.xls')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('预检')
                .setDescription('对导入计划执行预检（不落地）')
                .addStringOption((opt) =>
                    opt
                        .setName('job_id')
                        .setDescription('导入阶段返回的任务ID')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('应用')
                .setDescription('应用导入计划（会写入映射并可创建缺失角色）')
                .addStringOption((opt) =>
                    opt
                        .setName('job_id')
                        .setDescription('导入阶段返回的任务ID')
                        .setRequired(true))
                .addBooleanOption((opt) =>
                    opt
                        .setName('确认执行')
                        .setDescription('必须设为 true 才会执行')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('状态')
                .setDescription('查看同步队列与近期导入任务状态'))
        .addSubcommand((sub) =>
            sub
                .setName('快照列表')
                .setDescription('查看最近配置快照')
                .addStringOption((opt) =>
                    opt
                        .setName('link_id')
                        .setDescription('可选：仅查看指定链路')))
        .addSubcommand((sub) =>
            sub
                .setName('回滚')
                .setDescription('按 snapshot_id 回滚映射配置')
                .addIntegerOption((opt) =>
                    opt
                        .setName('snapshot_id')
                        .setDescription('快照ID')
                        .setRequired(true))
                .addBooleanOption((opt) =>
                    opt
                        .setName('确认执行')
                        .setDescription('必须为 true')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('对账成员')
                .setDescription('按单个成员进行对账并补齐同步任务')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('同步链路ID').setRequired(true))
                .addUserOption((opt) =>
                    opt.setName('成员').setDescription('要对账的成员').setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('对账批次')
                .setDescription('按链路批量对账交集成员')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('同步链路ID').setRequired(true))
                .addIntegerOption((opt) =>
                    opt.setName('数量').setDescription('本次扫描人数，默认20').setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('偏移').setDescription('扫描偏移，默认0').setRequired(false)))
        .addSubcommand((sub) =>
            sub
                .setName('触发自动对账')
                .setDescription('立即触发一轮自动对账（不等待定时器）'))
        .addSubcommand((sub) =>
            sub
                .setName('设置链路状态')
                .setDescription('启用或停用指定链路')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('同步链路ID').setRequired(true))
                .addBooleanOption((opt) =>
                    opt.setName('启用').setDescription('true=启用，false=停用').setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('全量采集成员')
                .setDescription('按链路采集成员存在性到数据库（用于对账预热）')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('同步链路ID').setRequired(true))
                .addStringOption((opt) =>
                    opt.setName('采集侧')
                        .setDescription('采集 source / target / both')
                        .addChoices(
                            { name: 'source', value: 'source' },
                            { name: 'target', value: 'target' },
                            { name: 'both', value: 'both' }
                        )
                        .setRequired(true))
                .addIntegerOption((opt) =>
                    opt.setName('数量上限').setDescription('0=不限（建议先小批量测试）').setRequired(false))
                .addBooleanOption((opt) =>
                    opt.setName('写入离开状态').setDescription('仅在数量上限=0时可开启').setRequired(false)))
        .addSubcommand((sub) =>
            sub
                .setName('导出成员数据')
                .setDescription('导出 guild_members 数据为 CSV 附件')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('可选：按链路筛选（导出交集成员所在的两个服务器）'))
                .addStringOption((opt) =>
                    opt.setName('guild_id').setDescription('可选：指定服务器ID'))
                .addBooleanOption((opt) =>
                    opt.setName('仅活跃').setDescription('仅导出活跃成员')))
        .addSubcommand((sub) =>
            sub
                .setName('停止采集')
                .setDescription('中断正在进行的全量采集任务')
                .addStringOption((opt) =>
                    opt.setName('guild_id').setDescription('要停止采集的服务器ID（默认当前服务器）').setRequired(false)))
        .addSubcommand((sub) =>
            sub
                .setName('全量对账')
                .setDescription('对链路所有交集成员进行全量对账（自动分批+进度+可中断）')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('同步链路ID').setRequired(true))
                .addIntegerOption((opt) =>
                    opt.setName('批次大小').setDescription('每批处理人数，默认50').setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('成员间隔ms').setDescription('成员间延迟毫秒，默认200').setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('批次间隔ms').setDescription('批次间延迟毫秒，默认2000').setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('起始偏移').setDescription('从第几个成员开始，默认0').setRequired(false)))
        .addSubcommand((sub) =>
            sub
                .setName('停止对账')
                .setDescription('中断正在进行的全量对账任务')
                .addStringOption((opt) =>
                    opt.setName('link_id').setDescription('要停止的链路ID').setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('防护设置')
                .setDescription('查看或修改角色删除防护参数（告警频道、熔断器）')
                .addStringOption((opt) =>
                    opt.setName('添加告警频道')
                        .setDescription('添加告警频道（频道ID，支持跨服）')
                        .setRequired(false))
                .addStringOption((opt) =>
                    opt.setName('移除告警频道')
                        .setDescription('移除告警频道（频道ID）')
                        .setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('熔断窗口ms')
                        .setDescription('熔断器滚动窗口（毫秒），默认10000')
                        .setMinValue(1000).setMaxValue(60000)
                        .setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('熔断阈值')
                        .setDescription('窗口内remove次数阈值，默认10')
                        .setMinValue(3).setMaxValue(100)
                        .setRequired(false))
                .addIntegerOption((opt) =>
                    opt.setName('熔断冷却ms')
                        .setDescription('熔断后阻断时长（毫秒），默认300000')
                        .setMinValue(10000).setMaxValue(3600000)
                        .setRequired(false))),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: true });

        try {
            if (sub === '导出当前服务器角色') {
                await handleExportCurrentGuild(interaction);
                return;
            }

            if (sub === '导出链路角色') {
                await handleExportLinkGuilds(interaction);
                return;
            }

            if (sub === '导入计划') {
                await handleImportPlan(interaction);
                return;
            }

            if (sub === '预检') {
                await handlePreviewJob(interaction);
                return;
            }

            if (sub === '应用') {
                await handleApplyJob(interaction);
                return;
            }

            if (sub === '状态') {
                await handleStatus(interaction);
                return;
            }

            if (sub === '快照列表') {
                await handleListSnapshots(interaction);
                return;
            }

            if (sub === '回滚') {
                await handleRollback(interaction);
                return;
            }

            if (sub === '对账成员') {
                await handleReconcileSingle(interaction);
                return;
            }

            if (sub === '对账批次') {
                await handleReconcileBatch(interaction);
                return;
            }

            if (sub === '触发自动对账') {
                await handleTriggerAutoReconcile(interaction);
                return;
            }

            if (sub === '设置链路状态') {
                await handleSetLinkEnabled(interaction);
                return;
            }

            if (sub === '全量采集成员') {
                await handleBootstrapMembers(interaction);
                return;
            }

            if (sub === '导出成员数据') {
                await handleExportMembers(interaction);
                return;
            }

            if (sub === '停止采集') {
                await handleStopBootstrap(interaction);
                return;
            }

            if (sub === '全量对账') {
                await handleReconcileFull(interaction);
                return;
            }

            if (sub === '停止对账') {
                await handleStopReconcile(interaction);
                return;
            }

            if (sub === '防护设置') {
                await handleProtectionSettings(interaction);
                return;
            }

            await interaction.editReply('❌ 未识别的子命令。');
        } catch (error) {
            console.error('[RoleSync] 指令执行失败:', error);

            const networkMsg = '⚠️ 网络连接短暂中断（ECONNRESET/超时）。请 3~10 秒后重试同一命令。';
            const isNetwork = /ECONNRESET|ETIMEDOUT|socket|fetch failed|network/i.test(String(error?.message || error));
            const message = isNetwork
                ? `${networkMsg}\n\n详情：${error.message || error}`
                : `❌ 执行失败：${error.message || error}`;

            await interaction.editReply(message);
        }
    },
};

async function handleExportCurrentGuild(interaction) {
    const csv = await exportGuildRolesCsv(interaction.guild);
    const fileName = `roles_export_${interaction.guild.id}_${Date.now()}.csv`;

    await interaction.editReply({
        content: `✅ 已导出当前服务器角色快照（${interaction.guild.name}）。`,
        files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: fileName })],
    });
}

async function handleExportLinkGuilds(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const data = await exportLinkRolesCsv(interaction.client, linkId);

    const sourceName = `roles_export_source_${data.sourceGuild.id}_${Date.now()}.csv`;
    const targetName = `roles_export_target_${data.targetGuild.id}_${Date.now()}.csv`;

    await interaction.editReply({
        content: `✅ 链路 **${linkId}** 导出完成。\n- source: ${data.sourceGuild.name}\n- target: ${data.targetGuild.name}`,
        files: [
            new AttachmentBuilder(Buffer.from(data.sourceCsv, 'utf8'), { name: sourceName }),
            new AttachmentBuilder(Buffer.from(data.targetCsv, 'utf8'), { name: targetName }),
        ],
    });
}

async function handleImportPlan(interaction) {
    const attachment = interaction.options.getAttachment('计划文件', true);
    const result = await importPlanFile({
        guildId: interaction.guild.id,
        attachment,
        createdBy: interaction.user.id,
    });

    const errorPreview = (result.errors || []).slice(0, 10);
    const errorText = errorPreview.length > 0
        ? `\n\n⚠️ 前 ${errorPreview.length} 条错误示例：\n${errorPreview.map((e) => `- 第${e.rowNumber}行：${e.errors.join('；')}`).join('\n')}`
        : '';

    await interaction.editReply([
        '✅ 计划文件导入成功。',
        `- job_id: \`${result.jobId}\``,
        `- 总行数: ${result.totalRows}`,
        `- 基础校验通过: ${result.validRows}`,
        `- 基础校验失败: ${result.invalidRows}`,
        '下一步请执行：`/身份组同步 预检 job_id:<...>`',
        errorText,
    ].join('\n'));
}

async function handlePreviewJob(interaction) {
    const jobId = interaction.options.getString('job_id', true);
    const preview = await previewImportJob(interaction.client, jobId);

    const invalidRows = preview.rows.filter((r) => !r.valid).slice(0, 15);
    const invalidText = invalidRows.length > 0
        ? `\n\n⚠️ 预检失败示例（前 ${invalidRows.length} 条）：\n${invalidRows.map((r) => `- 第${r.rowNumber}行：${r.messages.join('；')}`).join('\n')}`
        : '';

    await interaction.editReply([
        '🔎 预检完成（未执行落地）。',
        `- 总行数: ${preview.totalRows}`,
        `- 基础校验失败: ${preview.baseInvalidRows}`,
        `- 预检通过: ${preview.previewValidRows}`,
        `- 预检失败: ${preview.previewInvalidRows}`,
        `- 将创建缺失角色: ${preview.willCreateRoles}`,
        `- UPSERT: ${preview.upsertActions} / DISABLE: ${preview.disableActions} / DELETE: ${preview.deleteActions}`,
        '确认无误后执行：`/身份组同步 应用 job_id:<...> 确认执行:true`',
        invalidText,
    ].join('\n'));
}

async function handleApplyJob(interaction) {
    const jobId = interaction.options.getString('job_id', true);
    const confirm = interaction.options.getBoolean('确认执行', true);

    if (!confirm) {
        await interaction.editReply('❌ 你未确认执行。请将 `确认执行` 设置为 true。');
        return;
    }

    const result = await applyImportJob(interaction.client, jobId, interaction.user.id);

    const failedPreview = (result.failures || []).slice(0, 15);
    const failedText = failedPreview.length > 0
        ? `\n\n⚠️ 失败示例（前 ${failedPreview.length} 条）：\n${failedPreview.map((e) => `- 第${e.rowNumber}行：${e.error}`).join('\n')}`
        : '';

    await interaction.editReply([
        '✅ 应用完成。',
        `- 实际应用行数: ${result.applied}`,
        `- 新建角色数: ${result.createdRoles}`,
        `- UPSERT: ${result.upserted}`,
        `- DISABLE: ${result.disabled}`,
        `- DELETE: ${result.deleted}`,
        `- SKIPPED: ${result.skipped}`,
        `- FAILED: ${result.failed}`,
        `- 快照: ${result.snapshots.map((s) => `${s.linkId}#${s.snapshotId}`).join(', ') || '无'}`,
        failedText,
    ].join('\n'));
}

async function handleStatus(interaction) {
    const status = getRoleSyncRuntimeStatus();

    const linkLines = status.links.length > 0
        ? status.links.map((l) => `- ${l.link_id}: ${l.source_guild_id} -> ${l.target_guild_id} (enabled=${l.enabled})`).join('\n')
        : '- 无链路';

    const jobsLines = status.recentImportJobs.length > 0
        ? status.recentImportJobs.map((j) => `- ${j.job_id} | ${j.status} | total=${j.total_rows} valid=${j.valid_rows} invalid=${j.invalid_rows}`).join('\n')
        : '- 无导入任务';

    await interaction.editReply([
        '📊 身份组同步状态',
        `- 队列状态: ${JSON.stringify(status.queueStatus)}`,
        `- 分通道状态: ${JSON.stringify(status.queueByLane)}`,
        '',
        '🔗 链路列表：',
        linkLines,
        '',
        '🧾 近期导入任务：',
        jobsLines,
    ].join('\n'));
}

async function handleListSnapshots(interaction) {
    const linkId = interaction.options.getString('link_id', false);
    const snapshots = listSnapshots({ linkId: linkId || null, limit: 20 });

    if (snapshots.length === 0) {
        await interaction.editReply('📝 暂无快照记录。');
        return;
    }

    await interaction.editReply([
        '📚 最近快照：',
        ...snapshots.map((s) => `- #${s.snapshot_id} | link=${s.link_id || '-'} | ${s.snapshot_name || '-'} | by=${s.created_by || '-'} | ${s.created_at}`),
    ].join('\n'));
}

async function handleRollback(interaction) {
    const snapshotId = interaction.options.getInteger('snapshot_id', true);
    const confirm = interaction.options.getBoolean('确认执行', true);

    if (!confirm) {
        await interaction.editReply('❌ 你未确认执行，已取消回滚。');
        return;
    }

    const result = rollbackBySnapshot(snapshotId, interaction.user.id);
    await interaction.editReply([
        '✅ 回滚完成。',
        `- link: ${result.linkId}`,
        `- 还原来源快照: #${result.restoredFromSnapshot}`,
        `- 还原映射行数: ${result.restoredRows}`,
        `- 回滚前备份快照: #${result.backupSnapshotId}`,
    ].join('\n'));
}

async function handleReconcileSingle(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const user = interaction.options.getUser('成员', true);

    const result = await reconcileSingleMember(interaction.client, linkId, user.id);
    if (result.skipped) {
        await interaction.editReply(`ℹ️ 已跳过：${result.reason}`);
        return;
    }

    await interaction.editReply(`✅ 对账完成，已计划同步任务 ${result.planned} 条（user=${user.tag}）。`);
}

async function handleReconcileBatch(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const size = interaction.options.getInteger('数量', false) ?? 20;
    const offset = interaction.options.getInteger('偏移', false) ?? 0;

    await interaction.editReply('⏳ 已开始批量对账，进度将在频道中更新...');

    let progressMsg = await interaction.channel.send('⏳ 正在准备批量对账...');
    let lastProgressUpdate = 0;
    const PROGRESS_INTERVAL_MS = 8000;

    const result = await reconcileBatch(interaction.client, linkId, {
        maxMembers: size,
        offset,
        onProgress: (progress) => {
            const now = Date.now();
            if (now - lastProgressUpdate < PROGRESS_INTERVAL_MS) return;
            lastProgressUpdate = now;

            progressMsg.edit([
                '⏳ 正在批量对账...',
                `- 进度: ${progress.processed}/${progress.scanned}`,
                `- 已计划同步任务: ${progress.planned}`,
                `- 已跳过: ${progress.skipped}`,
                `- 失败: ${progress.failed}`,
            ].join('\n')).catch(() => {});
        },
    });

    await progressMsg.edit([
        `✅ 批量对账完成。<@${interaction.user.id}>`,
        `- link: ${result.linkId}`,
        `- 交集成员总量: ${result.totalEligible}`,
        `- 本次扫描: ${result.scanned}`,
        `- 已处理: ${result.processed}`,
        `- 已跳过: ${result.skipped}`,
        `- 已计划任务: ${result.planned}`,
        `- 失败: ${result.failed}`,
        `- next_offset: ${result.nextOffset}`,
    ].join('\n'));
}

async function handleTriggerAutoReconcile(interaction) {
    const result = await runAutoReconcileManual(interaction.client);
    const runtime = getReconcileRuntimeStatus();

    await interaction.editReply([
        result?.skipped ? 'ℹ️ 自动对账跳过。' : '✅ 已触发一轮自动对账。',
        `- 结果: ${JSON.stringify(result)}`,
        `- 运行状态: ${JSON.stringify(runtime.auto)}`,
    ].join('\n'));
}

async function handleSetLinkEnabled(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const enabled = interaction.options.getBoolean('启用', true);
    const before = listSyncLinks().find((x) => x.link_id === linkId);
    const result = setLinkEnabled(linkId, enabled);
    await interaction.editReply(`✅ 链路 ${result.linkId} 已${result.enabled ? '启用' : '停用'}。\n（此前状态: ${before ? Number(before.enabled) === 1 : 'unknown'}）`);
}

async function handleBootstrapMembers(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const side = interaction.options.getString('采集侧', true);
    const maxMembers = interaction.options.getInteger('数量上限', false) ?? 0;
    const markMissingInactive = interaction.options.getBoolean('写入离开状态', false) ?? false;

    await interaction.editReply('⏳ 已开始采集成员，进度将在频道中更新...');

    // 在频道中发送独立的进度消息，不受交互 15 分钟超时限制
    let progressMsg = await interaction.channel.send('⏳ 正在准备采集...');
    let lastProgressUpdate = 0;
    const PROGRESS_INTERVAL_MS = 8000;

    const result = await bootstrapMembersForLink(interaction.client, linkId, {
        side,
        maxMembers,
        markMissingInactive,
        onProgress: (progress) => {
            const now = Date.now();
            if (now - lastProgressUpdate < PROGRESS_INTERVAL_MS) return;
            lastProgressUpdate = now;

            progressMsg.edit(
                `⏳ 正在采集成员...\n` +
                `- 服务器: ${progress.guildName || progress.guildId} (${progress.guildIndex + 1}/${progress.totalGuilds})\n` +
                `- 已扫描: ${progress.scanned.toLocaleString()} 人\n` +
                `- 已处理页数: ${progress.pages}`
            ).catch(() => {});
        },
    });

    const details = result.details || [];
    const hasAborted = details.some((d) => d.aborted);
    const statusEmoji = hasAborted ? '⚠️' : '✅';
    const statusText = hasAborted ? '成员采集已中断' : '成员采集完成';

    await progressMsg.edit([
        `${statusEmoji} ${statusText}。<@${interaction.user.id}>`,
        `- link: ${result.linkId}`,
        `- side: ${result.side}`,
        `- maxMembers: ${result.maxMembers}`,
        `- 写入离开状态: ${result.markMissingInactive}`,
        `- 耗时: ${result.tookMs}ms`,
        ...details.map((d) => `  • ${d.guildName}(${d.guildId}) scanned=${d.scanned}, pages=${d.pages}, completed=${d.completed}${d.aborted ? '(已中断)' : ''}, limitReached=${d.limitReached}, deactivated=${d.deactivated}`),
    ].join('\n'));
}

async function handleStopBootstrap(interaction) {
    const guildId = interaction.options.getString('guild_id', false) || interaction.guildId;
    const stopped = stopBootstrap(guildId);
    if (stopped) {
        await interaction.editReply(`🛑 已发送中断信号，服务器 ${guildId} 的采集将在当前页处理完后停止。`);
    } else {
        await interaction.editReply(`ℹ️ 服务器 ${guildId} 当前没有正在进行的采集任务。`);
    }
}

async function handleReconcileFull(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const batchSize = interaction.options.getInteger('批次大小', false) ?? 50;
    const memberDelayMs = interaction.options.getInteger('成员间隔ms', false) ?? 200;
    const batchDelayMs = interaction.options.getInteger('批次间隔ms', false) ?? 2000;
    const offset = interaction.options.getInteger('起始偏移', false) ?? 0;

    if (isReconcileRunning(linkId)) {
        await interaction.editReply(`⚠️ 链路 ${linkId} 已有全量对账正在运行。使用 \`/身份组同步 停止对账\` 中断。`);
        return;
    }

    await interaction.editReply('⏳ 已开始全量对账，进度将在频道中更新...');

    let progressMsg = await interaction.channel.send('⏳ 正在准备全量对账...');
    let lastProgressUpdate = 0;
    const PROGRESS_INTERVAL_MS = 8000;

    try {
        const result = await reconcileFull(interaction.client, linkId, {
            batchSize,
            memberDelayMs,
            batchDelayMs,
            offset,
            onProgress: (progress) => {
                const now = Date.now();
                if (now - lastProgressUpdate < PROGRESS_INTERVAL_MS) return;
                lastProgressUpdate = now;

                const pct = progress.totalEligible > 0
                    ? ((progress.processed / progress.totalEligible) * 100).toFixed(1)
                    : '?';

                progressMsg.edit([
                    '⏳ 正在全量对账...',
                    `- 进度: ${progress.processed.toLocaleString()}/${progress.totalEligible.toLocaleString()} (${pct}%)`,
                    `- 已计划同步任务: ${progress.planned}`,
                    `- 已跳过: ${progress.skipped}`,
                    `- 失败: ${progress.failed}`,
                ].join('\n')).catch(() => {});
            },
        });

        const statusEmoji = result.aborted ? '⚠️' : '✅';
        const statusText = result.aborted ? '全量对账已中断' : '全量对账完成';

        await progressMsg.edit([
            `${statusEmoji} ${statusText}。<@${interaction.user.id}>`,
            `- link: ${result.linkId}`,
            `- 交集成员总量: ${result.totalEligible.toLocaleString()}`,
            `- 已处理: ${result.processed.toLocaleString()}`,
            `- 已跳过: ${result.skipped}`,
            `- 已计划同步任务: ${result.planned}`,
            `- 失败: ${result.failed}`,
            result.aborted ? '- 状态: 已被手动中断' : '',
            result.failures.length > 0
                ? `- 失败示例: ${result.failures.slice(0, 5).map((f) => f.userId).join(', ')}`
                : '',
        ].filter(Boolean).join('\n'));
    } catch (err) {
        await progressMsg.edit(
            `❌ 全量对账失败: ${err.message || err}`
        ).catch(() => {});
    }
}

async function handleStopReconcile(interaction) {
    const linkId = interaction.options.getString('link_id', true);
    const stopped = stopReconcile(linkId);
    if (stopped) {
        await interaction.editReply(`🛑 已发送中断信号，链路 ${linkId} 的全量对账将在当前成员处理完后停止。`);
    } else {
        await interaction.editReply(`ℹ️ 链路 ${linkId} 当前没有正在进行的全量对账任务。`);
    }
}

async function handleExportMembers(interaction) {
    const db = getRoleSyncDb();
    const linkId = interaction.options.getString('link_id', false);
    const guildId = interaction.options.getString('guild_id', false);
    const activeOnly = interaction.options.getBoolean('仅活跃', false) ?? false;

    const conditions = [];
    const params = {};

    if (linkId) {
        const link = db.prepare('SELECT source_guild_id, target_guild_id FROM sync_links WHERE link_id = ?').get(linkId);
        if (!link) {
            return interaction.editReply(`❌ 未找到链路 \`${linkId}\`。`);
        }
        conditions.push('gm.guild_id IN ($srcGuild, $tgtGuild)');
        params.$srcGuild = link.source_guild_id;
        params.$tgtGuild = link.target_guild_id;
    }

    if (guildId) {
        conditions.push('gm.guild_id = $guildId');
        params.$guildId = guildId;
    }

    if (activeOnly) {
        conditions.push('gm.is_active = 1');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db.prepare(`SELECT COUNT(1) AS total FROM guild_members gm ${where}`).get(params);

    if (countRow.total === 0) {
        return interaction.editReply('❌ 没有符合条件的成员数据。');
    }

    // Build CSV
    const csvParts = ['\ufeffguild_id,guild_name,user_id,is_active,joined_at,left_at,updated_at\n'];
    const stmt = db.prepare(`SELECT gm.*, g.guild_name FROM guild_members gm LEFT JOIN guilds g ON gm.guild_id = g.guild_id ${where} ORDER BY gm.guild_id, gm.user_id`);

    for (const row of stmt.iterate(params)) {
        csvParts.push([
            row.guild_id,
            `"${(row.guild_name || '').replace(/"/g, '""')}"`,
            row.user_id,
            row.is_active,
            row.joined_at || '',
            row.left_at || '',
            row.updated_at || '',
        ].join(',') + '\n');
    }

    const csvString = csvParts.join('');
    const csvBuffer = Buffer.from(csvString, 'utf8');

    if (csvBuffer.length > 24 * 1024 * 1024) {
        return interaction.editReply(`⚠️ 数据量过大（${(csvBuffer.length / 1024 / 1024).toFixed(1)}MB，共 ${countRow.total} 条），超过 Discord 25MB 附件上限。请使用 Web 面板导出或添加筛选条件缩小范围。`);
    }

    const fileName = `members_export_${Date.now()}.csv`;
    await interaction.editReply({
        content: `✅ 已导出 ${countRow.total} 条成员记录。`,
        files: [new AttachmentBuilder(csvBuffer, { name: fileName })],
    });
}

const ENV_ALERT_CHANNEL_IDS = process.env.ROLE_SYNC_ALERT_CHANNEL_ID || '';
const ENV_CB_WINDOW_MS = Number(process.env.ROLE_SYNC_CB_WINDOW_MS) || 10000;
const ENV_CB_THRESHOLD = Number(process.env.ROLE_SYNC_CB_THRESHOLD) || 10;
const ENV_CB_BLOCK_MS = Number(process.env.ROLE_SYNC_CB_BLOCK_MS) || 5 * 60 * 1000;

function getAlertChannelIdsForDisplay() {
    const dbValue = getRoleSyncSetting('alert_channel_ids', null);
    const raw = dbValue || ENV_ALERT_CHANNEL_IDS;
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function handleProtectionSettings(interaction) {
    const addChannelOpt = interaction.options.getString('添加告警频道');
    const removeChannelOpt = interaction.options.getString('移除告警频道');
    const windowOpt = interaction.options.getInteger('熔断窗口ms');
    const threshOpt = interaction.options.getInteger('熔断阈值');
    const blockOpt = interaction.options.getInteger('熔断冷却ms');

    const changes = [];

    // 处理告警频道增删
    if (addChannelOpt || removeChannelOpt) {
        const currentIds = getAlertChannelIdsForDisplay();
        const idSet = new Set(currentIds);

        if (addChannelOpt) {
            const channelId = addChannelOpt.replace(/\D/g, '');
            if (channelId) {
                // 验证频道是否可达
                const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
                if (!ch || !ch.isTextBased()) {
                    await interaction.editReply(`❌ 频道 \`${channelId}\` 不存在或非文本频道（Bot 可能不在该服务器中）。`);
                    return;
                }
                if (idSet.has(channelId)) {
                    changes.push(`告警频道 <#${channelId}> 已存在，跳过`);
                } else {
                    idSet.add(channelId);
                    changes.push(`添加告警频道 → <#${channelId}>`);
                }
            }
        }

        if (removeChannelOpt) {
            const channelId = removeChannelOpt.replace(/\D/g, '');
            if (channelId && idSet.has(channelId)) {
                idSet.delete(channelId);
                changes.push(`移除告警频道 → ${channelId}`);
            } else if (channelId) {
                changes.push(`频道 \`${channelId}\` 不在告警列表中`);
            }
        }

        setRoleSyncSetting('alert_channel_ids', Array.from(idSet).join(','));
    }

    if (windowOpt !== null && windowOpt !== undefined) {
        setRoleSyncSetting('cb_window_ms', windowOpt);
        changes.push(`熔断窗口 → ${windowOpt}ms`);
    }
    if (threshOpt !== null && threshOpt !== undefined) {
        setRoleSyncSetting('cb_threshold', threshOpt);
        changes.push(`熔断阈值 → ${threshOpt}`);
    }
    if (blockOpt !== null && blockOpt !== undefined) {
        setRoleSyncSetting('cb_block_ms', blockOpt);
        changes.push(`熔断冷却 → ${blockOpt}ms`);
    }

    const channelIds = getAlertChannelIdsForDisplay();
    const currentWindow = Number(getRoleSyncSetting('cb_window_ms', ENV_CB_WINDOW_MS));
    const currentThresh = Number(getRoleSyncSetting('cb_threshold', ENV_CB_THRESHOLD));
    const currentBlock = Number(getRoleSyncSetting('cb_block_ms', ENV_CB_BLOCK_MS));

    const channelDisplay = channelIds.length > 0
        ? channelIds.map(id => `<#${id}>`).join(', ')
        : '未设置（仅控制台）';

    let reply = '**🛡️ 角色删除防护设置**\n\n';
    reply += `告警频道: ${channelDisplay}\n`;
    reply += `熔断窗口: ${currentWindow}ms\n`;
    reply += `熔断阈值: ${currentThresh} 次/窗口\n`;
    reply += `熔断冷却: ${currentBlock}ms（${Math.round(currentBlock / 60000)}分钟）\n`;

    if (changes.length > 0) {
        reply += `\n✅ 已更新: ${changes.join(', ')}`;
    } else {
        reply += '\n💡 传入参数可修改设置，例如:\n`/身份组同步 防护设置 添加告警频道:123456789 熔断阈值:15`';
    }

    await interaction.editReply({ content: reply });
}
