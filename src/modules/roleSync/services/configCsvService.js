const crypto = require('crypto');
const xlsx = require('xlsx');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const {
    getSyncLinkById,
    listSyncLinks,
    listRoleSyncMapByLinkIds,
    createConfigSnapshot,
    upsertRoleSyncMap,
    removeRoleSyncMap,
    createConfigImportJob,
    getConfigImportJob,
    updateConfigImportJobPreview,
    markConfigImportJobApplied,
    markConfigImportJobFailed,
    listRecentConfigImportJobs,
    getSyncJobCountByStatus,
    getConfigSnapshot,
    listConfigSnapshots,
    replaceRoleSyncMapForLink,
    listRoleSyncMapByLink,
    updateSyncLinkEnabled,
    getSyncJobCountByLane,
    upsertGuild,
    upsertGuildMemberPresenceBatch,
    deactivateAllGuildMembers,
    extractRolesJson,
} = require('../utils/roleSyncDatabase');
const {
    reconcileLinkMember,
    reconcileLinkMembersBatch,
    runAutoReconcileOnce,
    getAutoReconcileStatus,
} = require('./reconcileService');
const { withRetry } = require('../utils/networkRetry');

const SAFE_PERMISSION_BITS = PermissionsBitField.resolve([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.UseExternalEmojis,
    PermissionFlagsBits.UseExternalStickers,
    PermissionFlagsBits.UseApplicationCommands,
]);

const ALLOWED_ACTIONS = new Set(['UPSERT', 'DISABLE', 'DELETE']);
const ALLOWED_SYNC_MODE = new Set(['bidirectional', 'source_to_target', 'target_to_source', 'disabled']);
const ALLOWED_COPY_PERM_MODE = new Set(['none', 'safe', 'strict']);

function escapeCsvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function buildCsv(rows, headers) {
    const lines = [headers.join(',')];
    for (const row of rows) {
        const values = headers.map((key) => escapeCsvCell(row[key]));
        lines.push(values.join(','));
    }
    return lines.join('\n');
}

function isUtf8Buffer(buf) {
    // 有 UTF-8 BOM 则直接判定为 UTF-8
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return true;
    }

    // 验证是否为合法 UTF-8 序列
    for (let i = 0; i < buf.length; ) {
        const byte = buf[i];
        let seqLen;
        if (byte <= 0x7F) { seqLen = 1; }
        else if ((byte & 0xE0) === 0xC0) { seqLen = 2; }
        else if ((byte & 0xF0) === 0xE0) { seqLen = 3; }
        else if ((byte & 0xF8) === 0xF0) { seqLen = 4; }
        else { return false; }

        if (i + seqLen > buf.length) return false;
        for (let j = 1; j < seqLen; j++) {
            if ((buf[i + j] & 0xC0) !== 0x80) return false;
        }
        i += seqLen;
    }
    return true;
}

function toBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined || value === '') return fallback;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
    return fallback;
}

function toInt(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
}

function normalizeRow(raw, rowNumber) {
    const row = {};
    for (const [key, value] of Object.entries(raw || {})) {
        row[String(key).trim().toLowerCase()] = value;
    }

    const action = String(row.action || 'UPSERT').trim().toUpperCase();

    return {
        rowNumber,
        planVersion: String(row.plan_version || 'v1').trim(),
        action,
        linkId: String(row.link_id || '').trim(),
        sourceGuildId: String(row.source_guild_id || '').trim(),
        targetGuildId: String(row.target_guild_id || '').trim(),
        sourceRoleId: String(row.source_role_id || '').trim(),
        targetRoleId: String(row.target_role_id || '').trim(),
        targetRoleNameIfCreate: String(row.target_role_name_if_create || '').trim(),
        createIfMissing: toBool(row.create_if_missing, false),
        copyVisual: toBool(row.copy_visual, true),
        copyPermissionsMode: String(row.copy_permissions_mode || 'none').trim().toLowerCase(),
        enabled: toBool(row.enabled, true),
        syncMode: String(row.sync_mode || 'source_to_target').trim(),
        conflictPolicy: String(row.conflict_policy || 'source_of_truth_main').trim(),
        maxDelaySeconds: toInt(row.max_delay_seconds, 120),
        targetRolePosition: toInt(row.target_role_position, -1),
        roleType: String(row.role_type || '').trim() || null,
        notes: String(row.notes || '').trim() || null,
    };
}

function validateRowBasic(row) {
    const errors = [];

    if (!ALLOWED_ACTIONS.has(row.action)) {
        errors.push('action 必须为 UPSERT / DISABLE / DELETE');
    }

    if (!row.linkId) {
        errors.push('缺少 link_id');
    }

    if (!/^\d{17,20}$/.test(row.sourceGuildId)) {
        errors.push('source_guild_id 非法');
    }

    if (!/^\d{17,20}$/.test(row.targetGuildId)) {
        errors.push('target_guild_id 非法');
    }

    if (!/^\d{17,20}$/.test(row.sourceRoleId)) {
        errors.push('source_role_id 非法');
    }

    if (row.targetRoleId && !/^\d{17,20}$/.test(row.targetRoleId)) {
        errors.push('target_role_id 非法');
    }

    if (!ALLOWED_COPY_PERM_MODE.has(row.copyPermissionsMode)) {
        errors.push('copy_permissions_mode 必须是 none/safe/strict');
    }

    if (!ALLOWED_SYNC_MODE.has(row.syncMode)) {
        errors.push('sync_mode 非法');
    }

    if (row.maxDelaySeconds <= 0 || row.maxDelaySeconds > 3600) {
        errors.push('max_delay_seconds 必须在 1~3600 之间');
    }

    if (row.action === 'UPSERT') {
        if (!row.targetRoleId && !row.createIfMissing) {
            errors.push('UPSERT 时 target_role_id 为空则 create_if_missing 必须为 true');
        }

        if (!row.targetRoleId && row.createIfMissing && !row.targetRoleNameIfCreate) {
            errors.push('create_if_missing=true 且 target_role_id 为空时，必须提供 target_role_name_if_create');
        }
    }

    if ((row.action === 'DISABLE' || row.action === 'DELETE') && !row.targetRoleId) {
        errors.push(`${row.action} 操作必须提供 target_role_id`);
    }

    if (row.targetRolePosition !== -1 && row.targetRolePosition < 0) {
        errors.push('target_role_position 必须 >= 0（留空或 -1 表示使用源角色位置）');
    }

    return errors;
}

async function parsePlanAttachment(attachment) {
    if (!attachment || !attachment.url) {
        throw new Error('未检测到上传文件');
    }

    const lowerName = String(attachment.name || '').toLowerCase();
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx') && !lowerName.endsWith('.xls')) {
        throw new Error('仅支持 .csv/.xlsx/.xls 文件');
    }

    const response = await withRetry(
        () => fetch(attachment.url),
        { retries: 3, baseDelayMs: 500, label: 'download_plan_file' }
    );
    if (!response.ok) {
        throw new Error(`下载计划文件失败: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const readOptions = { type: 'buffer' };
    if (lowerName.endsWith('.csv') && !isUtf8Buffer(buffer)) {
        readOptions.codepage = 936; // GBK
    }
    const workbook = xlsx.read(buffer, readOptions);
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
        throw new Error('文件中没有可读取的工作表');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rawRows = xlsx.utils.sheet_to_json(sheet, {
        defval: '',
        raw: false,
    });

    const parsedRows = rawRows.map((row, index) => normalizeRow(row, index + 2));
    const errors = [];

    let validRows = 0;
    for (const row of parsedRows) {
        const rowErrors = validateRowBasic(row);
        if (rowErrors.length > 0) {
            errors.push({ rowNumber: row.rowNumber, errors: rowErrors });
        } else {
            validRows += 1;
        }
    }

    return {
        parsedRows,
        validRows,
        invalidRows: parsedRows.length - validRows,
        errors,
    };
}

function createImportJobId() {
    return `rsimp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

async function importPlanFile({ guildId, attachment, createdBy }) {
    const parsed = await parsePlanAttachment(attachment);
    const jobId = createImportJobId();

    createConfigImportJob({
        jobId,
        guildId,
        fileName: attachment.name || null,
        parsedRows: parsed.parsedRows,
        validRows: parsed.validRows,
        invalidRows: parsed.invalidRows,
        errors: parsed.errors,
        createdBy,
    });

    return {
        jobId,
        totalRows: parsed.parsedRows.length,
        validRows: parsed.validRows,
        invalidRows: parsed.invalidRows,
        errors: parsed.errors,
    };
}

function resolveLinkValidation(row) {
    const link = getSyncLinkById(row.linkId);
    if (!link) {
        return { ok: false, reason: 'link_id 不存在' };
    }

    if (link.source_guild_id !== row.sourceGuildId || link.target_guild_id !== row.targetGuildId) {
        return { ok: false, reason: 'source/target guild 与链路定义不一致' };
    }

    return { ok: true, link };
}

async function previewImportJob(client, jobId) {
    const job = getConfigImportJob(jobId);
    if (!job) {
        throw new Error('未找到对应 job_id');
    }

    const summary = {
        totalRows: job.total_rows,
        baseInvalidRows: job.invalid_rows,
        previewValidRows: 0,
        previewInvalidRows: 0,
        willCreateRoles: 0,
        upsertActions: 0,
        disableActions: 0,
        deleteActions: 0,
        rows: [],
    };

    for (const row of job.parsedRows) {
        const rowResult = {
            rowNumber: row.rowNumber,
            action: row.action,
            linkId: row.linkId,
            valid: false,
            messages: [],
            resolvedTargetRoleId: row.targetRoleId || null,
            willCreateRole: false,
        };

        const basicErrors = validateRowBasic(row);
        if (basicErrors.length > 0) {
            rowResult.messages.push(...basicErrors);
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        const linkCheck = resolveLinkValidation(row);
        if (!linkCheck.ok) {
            rowResult.messages.push(linkCheck.reason);
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        const sourceGuild = await withRetry(
            () => client.guilds.fetch(row.sourceGuildId),
            { retries: 2, baseDelayMs: 400, label: `preview_source_guild_${row.sourceGuildId}` }
        ).catch(() => null);
        if (!sourceGuild) {
            rowResult.messages.push('无法访问 source_guild');
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        const targetGuild = await withRetry(
            () => client.guilds.fetch(row.targetGuildId),
            { retries: 2, baseDelayMs: 400, label: `preview_target_guild_${row.targetGuildId}` }
        ).catch(() => null);
        if (!targetGuild) {
            rowResult.messages.push('无法访问 target_guild');
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        const sourceRole = await withRetry(
            () => sourceGuild.roles.fetch(row.sourceRoleId),
            { retries: 2, baseDelayMs: 350, label: `preview_source_role_${row.sourceRoleId}` }
        ).catch(() => null);
        if (!sourceRole) {
            rowResult.messages.push('source_role_id 在 source_guild 不存在');
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        if (sourceRole.managed || sourceRole.id === sourceGuild.id) {
            rowResult.messages.push('source 角色为托管角色或 @everyone，不允许同步');
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        let targetRole = null;
        if (row.targetRoleId) {
            targetRole = await withRetry(
                () => targetGuild.roles.fetch(row.targetRoleId),
                { retries: 2, baseDelayMs: 350, label: `preview_target_role_${row.targetRoleId}` }
            ).catch(() => null);
        }

        if (!targetRole && !row.createIfMissing && row.action === 'UPSERT') {
            rowResult.messages.push('target_role_id 不存在，且未开启 create_if_missing');
            summary.previewInvalidRows += 1;
            summary.rows.push(rowResult);
            continue;
        }

        if (!targetRole && row.createIfMissing && row.action === 'UPSERT') {
            rowResult.willCreateRole = true;
            summary.willCreateRoles += 1;
        }

        rowResult.valid = true;
        rowResult.messages.push('预检通过');
        summary.previewValidRows += 1;

        if (row.action === 'UPSERT') summary.upsertActions += 1;
        if (row.action === 'DISABLE') summary.disableActions += 1;
        if (row.action === 'DELETE') summary.deleteActions += 1;

        summary.rows.push(rowResult);
    }

    updateConfigImportJobPreview(jobId, summary);
    return summary;
}

function resolvePermissionsForCreate(sourceRole, mode) {
    const bits = sourceRole.permissions?.bitfield || 0n;

    if (mode === 'strict') {
        return bits;
    }

    if (mode === 'safe') {
        return bits & SAFE_PERMISSION_BITS;
    }

    return 0n;
}

async function ensureTargetRole({ row, sourceRole, targetGuild }) {
    if (row.targetRoleId) {
        const existed = await withRetry(
            () => targetGuild.roles.fetch(row.targetRoleId),
            { retries: 2, baseDelayMs: 350, label: `ensure_target_role_${row.targetRoleId}` }
        ).catch(() => null);
        if (existed) {
            return existed;
        }
    }

    if (!row.createIfMissing || row.action !== 'UPSERT') {
        return null;
    }

    const createPayload = {
        name: row.targetRoleNameIfCreate || sourceRole.name,
        reason: `[RoleSync] CSV导入自动创建角色 link=${row.linkId} sourceRole=${row.sourceRoleId}`,
    };

    if (row.copyVisual) {
        createPayload.color = sourceRole.color;
        createPayload.hoist = sourceRole.hoist;
        createPayload.mentionable = sourceRole.mentionable;
    }

    createPayload.permissions = resolvePermissionsForCreate(sourceRole, row.copyPermissionsMode);

    const createdRole = await withRetry(
        () => targetGuild.roles.create(createPayload),
        { retries: 2, baseDelayMs: 500, label: `create_role_link_${row.linkId}` }
    );
    return createdRole;
}

async function applyCreatedRolePositions(client, createdRoleEntries) {
    if (createdRoleEntries.length === 0) {
        return;
    }

    // 按目标服务器分组
    const byGuild = new Map();
    for (const entry of createdRoleEntries) {
        if (!byGuild.has(entry.targetGuildId)) {
            byGuild.set(entry.targetGuildId, []);
        }
        byGuild.get(entry.targetGuildId).push(entry);
    }

    for (const [guildId, entries] of byGuild) {
        // 按文件行序排列（靠前 = 更高位置）
        entries.sort((a, b) => a.fileOrder - b.fileOrder);

        // 找锚点：第一个指定了 target_role_position 的角色
        const anchorIdx = entries.findIndex((e) => e.targetRolePosition >= 0);
        if (anchorIdx === -1) {
            // 全部没填位置，跳过
            continue;
        }

        const anchorPos = entries[anchorIdx].targetRolePosition;

        // 从锚点向两边推算位置：锚点上方的角色 position 更大，下方更小
        const positionUpdates = [];
        for (let i = 0; i < entries.length; i++) {
            const pos = anchorPos - (i - anchorIdx);
            if (pos >= 1) {
                positionUpdates.push({ role: entries[i].roleId, position: pos });
            }
        }

        if (positionUpdates.length === 0) {
            continue;
        }

        try {
            const guild = await withRetry(
                () => client.guilds.fetch(guildId),
                { retries: 2, baseDelayMs: 350, label: `position_fetch_guild_${guildId}` }
            );
            await withRetry(
                () => guild.roles.setPositions(positionUpdates),
                { retries: 2, baseDelayMs: 500, label: `position_set_roles_${guildId}` }
            );
            console.log(`[RoleSync] ✅ 已为 ${guild.name} 批量设置 ${positionUpdates.length} 个新角色位置`);
        } catch (err) {
            console.error(`[RoleSync] ⚠️ 设置角色位置失败（guild=${guildId}）:`, err.message || err);
        }
    }
}

async function applyImportJob(client, jobId, operatorId) {
    const job = getConfigImportJob(jobId);
    if (!job) {
        throw new Error('未找到对应 job_id');
    }

    const preview = job.preview || await previewImportJob(client, jobId);
    const validRows = preview.rows.filter((row) => row.valid);

    if (validRows.length === 0) {
        throw new Error('预检后无可应用行，请先修正计划文件');
    }

    const rowsByNumber = new Map(job.parsedRows.map((row) => [row.rowNumber, row]));
    const affectedLinkIds = [...new Set(validRows.map((row) => row.linkId))];

    // 创建快照，便于后续回滚
    const beforeMappings = listRoleSyncMapByLinkIds(affectedLinkIds);
    const grouped = new Map();
    for (const map of beforeMappings) {
        if (!grouped.has(map.link_id)) grouped.set(map.link_id, []);
        grouped.get(map.link_id).push(map);
    }

    const snapshotIds = [];
    for (const linkId of affectedLinkIds) {
        const snapshotId = createConfigSnapshot({
            linkId,
            snapshotName: `csv_apply_${jobId}`,
            snapshotJson: JSON.stringify(grouped.get(linkId) || []),
            createdBy: operatorId,
        });
        snapshotIds.push({ linkId, snapshotId });
    }

    const results = {
        applied: 0,
        createdRoles: 0,
        upserted: 0,
        disabled: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
        failures: [],
        snapshots: snapshotIds,
    };

    const createdRoleEntries = [];

    for (const previewRow of validRows) {
        const row = rowsByNumber.get(previewRow.rowNumber);
        if (!row) {
            continue;
        }

        try {
            const sourceGuild = await withRetry(
                () => client.guilds.fetch(row.sourceGuildId),
                { retries: 2, baseDelayMs: 450, label: `apply_source_guild_${row.sourceGuildId}` }
            );
            const targetGuild = await withRetry(
                () => client.guilds.fetch(row.targetGuildId),
                { retries: 2, baseDelayMs: 450, label: `apply_target_guild_${row.targetGuildId}` }
            );
            const sourceRole = await withRetry(
                () => sourceGuild.roles.fetch(row.sourceRoleId),
                { retries: 2, baseDelayMs: 350, label: `apply_source_role_${row.sourceRoleId}` }
            );

            const targetRole = await ensureTargetRole({ row, sourceRole, targetGuild });

            const targetRoleId = targetRole ? targetRole.id : row.targetRoleId;
            if (!targetRoleId) {
                results.skipped += 1;
                continue;
            }

            const isNewlyCreated = targetRole && (!row.targetRoleId || row.targetRoleId !== targetRole.id);
            if (isNewlyCreated) {
                results.createdRoles += 1;
                createdRoleEntries.push({
                    targetGuildId: row.targetGuildId,
                    roleId: targetRole.id,
                    fileOrder: previewRow.rowNumber,
                    targetRolePosition: row.targetRolePosition,
                });
            }

            if (row.action === 'DELETE') {
                removeRoleSyncMap({
                    linkId: row.linkId,
                    sourceRoleId: row.sourceRoleId,
                    targetRoleId,
                });
                results.deleted += 1;
            } else if (row.action === 'DISABLE') {
                upsertRoleSyncMap({
                    linkId: row.linkId,
                    sourceRoleId: row.sourceRoleId,
                    targetRoleId,
                    enabled: false,
                    syncMode: row.syncMode,
                    conflictPolicy: row.conflictPolicy,
                    maxDelaySeconds: row.maxDelaySeconds,
                    roleType: row.roleType,
                    copyVisual: row.copyVisual,
                    copyPermissionsMode: row.copyPermissionsMode,
                    note: row.notes,
                });
                results.disabled += 1;
            } else {
                upsertRoleSyncMap({
                    linkId: row.linkId,
                    sourceRoleId: row.sourceRoleId,
                    targetRoleId,
                    enabled: row.enabled,
                    syncMode: row.syncMode,
                    conflictPolicy: row.conflictPolicy,
                    maxDelaySeconds: row.maxDelaySeconds,
                    roleType: row.roleType,
                    copyVisual: row.copyVisual,
                    copyPermissionsMode: row.copyPermissionsMode,
                    note: row.notes,
                });
                results.upserted += 1;
            }

            results.applied += 1;
        } catch (err) {
            results.failed += 1;
            results.failures.push({ rowNumber: row.rowNumber, error: err.message || String(err) });
        }
    }

    // 批量设置新创建角色的位置（锚点 + 文件顺序）
    await applyCreatedRolePositions(client, createdRoleEntries);

    if (results.failed > 0) {
        markConfigImportJobFailed(jobId, `部分行执行失败，failed=${results.failed}`);
    } else {
        markConfigImportJobApplied(jobId, results);
    }

    return results;
}

function formatRoleForExport(role) {
    return {
        guild_id: role.guild.id,
        role_id: role.id,
        role_name: role.name,
        position: role.position,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.bitfield.toString(),
        is_managed: role.managed,
        is_everyone: role.id === role.guild.id,
    };
}

function sortRolesForExport(roles) {
    return [...roles].sort((a, b) => b.position - a.position);
}

async function exportGuildRolesCsv(guild) {
    const roles = await guild.roles.fetch();
    const rows = sortRolesForExport(Array.from(roles.values())).map(formatRoleForExport);

    const headers = [
        'guild_id',
        'role_id',
        'role_name',
        'position',
        'color',
        'hoist',
        'mentionable',
        'permissions',
        'is_managed',
        'is_everyone',
    ];

    return buildCsv(rows, headers);
}

async function exportLinkRolesCsv(client, linkId) {
    const link = getSyncLinkById(linkId);
    if (!link) {
        throw new Error('link_id 不存在');
    }

    const sourceGuild = await withRetry(
        () => client.guilds.fetch(link.source_guild_id),
        { retries: 2, baseDelayMs: 350, label: `export_source_guild_${link.source_guild_id}` }
    );
    const targetGuild = await withRetry(
        () => client.guilds.fetch(link.target_guild_id),
        { retries: 2, baseDelayMs: 350, label: `export_target_guild_${link.target_guild_id}` }
    );

    const sourceCsv = await exportGuildRolesCsv(sourceGuild);
    const targetCsv = await exportGuildRolesCsv(targetGuild);

    return {
        link,
        sourceGuild,
        targetGuild,
        sourceCsv,
        targetCsv,
    };
}

function getRoleSyncRuntimeStatus() {
    return {
        links: listSyncLinks(),
        queueStatus: getSyncJobCountByStatus(),
        queueByLane: getSyncJobCountByLane(),
        recentImportJobs: listRecentConfigImportJobs(8),
    };
}

function listSnapshots({ linkId = null, limit = 20 } = {}) {
    return listConfigSnapshots({ linkId, limit });
}

function rollbackBySnapshot(snapshotId, operatorId) {
    const snapshot = getConfigSnapshot(snapshotId);
    if (!snapshot) {
        throw new Error('snapshot_id 不存在');
    }

    if (!snapshot.link_id) {
        throw new Error('该快照缺少 link_id，无法回滚');
    }

    const currentRows = listRoleSyncMapByLink(snapshot.link_id);
    const backupSnapshotId = createConfigSnapshot({
        linkId: snapshot.link_id,
        snapshotName: `rollback_backup_before_${snapshotId}`,
        snapshotJson: JSON.stringify(currentRows),
        createdBy: operatorId || null,
    });

    replaceRoleSyncMapForLink(snapshot.link_id, snapshot.snapshotRows || []);

    return {
        linkId: snapshot.link_id,
        restoredFromSnapshot: snapshot.snapshot_id,
        restoredRows: Array.isArray(snapshot.snapshotRows) ? snapshot.snapshotRows.length : 0,
        backupSnapshotId,
    };
}

function setLinkEnabled(linkId, enabled) {
    const changed = updateSyncLinkEnabled(linkId, enabled);
    if (changed <= 0) {
        throw new Error('link_id 不存在或状态未变化');
    }
    return { linkId, enabled: !!enabled };
}

function resolveBootstrapGuildIds(link, side) {
    const normalized = String(side || 'both').toLowerCase();
    if (normalized === 'source') return [link.source_guild_id];
    if (normalized === 'target') return [link.target_guild_id];
    return [link.source_guild_id, link.target_guild_id];
}

// 存储正在运行的采集任务 signal，用于中断
const activeBootstraps = new Map();

/**
 * 中断指定服务器的采集任务。
 * @returns {boolean} 是否找到并中断了任务
 */
function stopBootstrap(guildId) {
    const signal = activeBootstraps.get(guildId);
    if (signal) {
        signal.shouldStop = true;
        return true;
    }
    return false;
}

/**
 * 通过 REST API 分页拉取服务器成员，每页立即写入数据库。
 * 避免 Gateway 全量拉取在大服务器（22万+成员）超时的问题。
 */
async function fetchMembersViaREST(guild, options = {}) {
    const maxMembers = Math.max(0, Number(options.maxMembers || 0));
    const onProgress = options.onProgress || (() => {});
    const signal = options.signal || { shouldStop: false };
    const PAGE_SIZE = 1000;

    let afterCursor = '0';
    let scanned = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
        if (signal.shouldStop) {
            return { scanned, pages, aborted: true };
        }

        const fetchLimit = maxMembers > 0
            ? Math.min(PAGE_SIZE, maxMembers - scanned)
            : PAGE_SIZE;

        if (fetchLimit <= 0) break;

        const members = await withRetry(
            () => guild.members.list({ limit: fetchLimit, after: afterCursor, cache: false }),
            { retries: 3, baseDelayMs: 1000, label: `rest_list_members_${guild.id}_page${pages}` }
        );

        if (members.size === 0) {
            hasMore = false;
            break;
        }

        const batchRows = [];
        for (const [, member] of members) {
            batchRows.push({
                userId: member.id,
                joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
                isActive: true,
                leftAt: null,
                rolesJson: extractRolesJson(member.roles.cache, guild.id),
            });
        }

        const validRows = batchRows.filter((it) => it.userId);
        if (validRows.length > 0) {
            upsertGuildMemberPresenceBatch(guild.id, validRows);
        }

        scanned += validRows.length;
        pages += 1;
        afterCursor = members.lastKey();

        onProgress(scanned, pages);

        if (members.size < fetchLimit) {
            hasMore = false;
        }
        if (maxMembers > 0 && scanned >= maxMembers) {
            hasMore = false;
        }

        if (hasMore) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    return { scanned, pages, aborted: false };
}

async function bootstrapGuildMembers(client, guildId, options = {}) {
    const maxMembers = Math.max(0, Number(options.maxMembers || 0));
    const markMissingInactive = options.markMissingInactive === true;
    const onProgress = options.onProgress || (() => {});

    if (markMissingInactive && maxMembers > 0) {
        throw new Error('开启”写入离开状态”时，数量上限必须为 0（全量）');
    }

    const guild = await withRetry(
        () => client.guilds.fetch(guildId),
        { retries: 2, baseDelayMs: 350, label: `bootstrap_fetch_guild_${guildId}` }
    );

    upsertGuild(guild.id, guild.name, 0);

    // 先标记全部不活跃，后续 upsert 会将拉取到的成员恢复为活跃
    let deactivated = 0;
    if (markMissingInactive) {
        deactivated = deactivateAllGuildMembers(guild.id);
    }

    // 注册中断 signal
    const signal = { shouldStop: false };
    activeBootstraps.set(guildId, signal);

    let result;
    try {
        result = await fetchMembersViaREST(guild, {
            maxMembers,
            signal,
            onProgress: (currentScanned, currentPages) => {
                onProgress({
                    guildId: guild.id,
                    guildName: guild.name,
                    scanned: currentScanned,
                    pages: currentPages,
                });
            },
        });
    } finally {
        activeBootstraps.delete(guildId);
    }

    return {
        guildId: guild.id,
        guildName: guild.name,
        scanned: result.scanned,
        pages: result.pages,
        completed: !result.aborted,
        aborted: result.aborted,
        limitReached: maxMembers > 0 && result.scanned >= maxMembers,
        deactivated,
    };
}

async function bootstrapMembersForLink(client, linkId, options = {}) {
    const link = getSyncLinkById(linkId);
    if (!link) {
        throw new Error('link_id 不存在');
    }

    const side = String(options.side || 'both').toLowerCase();
    const maxMembers = Math.max(0, Number(options.maxMembers || 0));
    const markMissingInactive = options.markMissingInactive === true;
    const onProgress = options.onProgress || (() => {});

    const guildIds = resolveBootstrapGuildIds(link, side);
    const startedAt = Date.now();
    const details = [];

    for (const guildId of guildIds) {
        const item = await bootstrapGuildMembers(client, guildId, {
            maxMembers,
            markMissingInactive,
            onProgress: (progress) => {
                onProgress({ ...progress, linkId, side, guildIndex: details.length, totalGuilds: guildIds.length });
            },
        });
        details.push(item);
    }

    return {
        linkId,
        side,
        maxMembers,
        markMissingInactive,
        tookMs: Date.now() - startedAt,
        details,
    };
}

async function reconcileSingleMember(client, linkId, userId) {
    return reconcileLinkMember(client, linkId, userId, { reason: 'manual_reconcile_single' });
}

async function reconcileBatch(client, linkId, options = {}) {
    return reconcileLinkMembersBatch(client, linkId, {
        maxMembers: options.maxMembers,
        offset: options.offset,
        reason: 'manual_reconcile_batch',
    });
}

async function runAutoReconcileManual(client) {
    return runAutoReconcileOnce(client);
}

function getReconcileRuntimeStatus() {
    return { auto: getAutoReconcileStatus() };
}

module.exports = {
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
    runAutoReconcileManual,
    getReconcileRuntimeStatus,
    setLinkEnabled,
    listSyncLinks,
    bootstrapMembersForLink,
    stopBootstrap,
};
