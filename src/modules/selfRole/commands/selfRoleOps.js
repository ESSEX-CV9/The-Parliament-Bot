// src/modules/selfRole/commands/selfRoleOps.js
//
// SelfRole 运维命令：将常用的“测试/诊断/手动触发”能力以正式运维命令形式提供。
// 鉴权：服务器 owner / Administrator / permissionManager.ALLOWED_ROLE_IDS（checkAdminPermission）
//
// 注意：该命令会触发真实的生命周期询问/强制清退/过期处理等行为，请谨慎使用。

const { SlashCommandBuilder } = require('discord.js');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const {
  getPendingSelfRoleApplicationV2ByApplicantRole,
  saveSelfRoleApplicationV2,
  getSelfRoleSettings,
  getActiveSelfRoleGrantByUserRole,
  listActiveSelfRoleGrantsByPrimaryRole,
  createSelfRoleGrant,
  endActiveSelfRoleGrantsForUserRole,
  updateSelfRoleGrantSchedule,
  listSelfRoleGrantRoles,
  countActiveSelfRoleGrantHoldersByRole,
  countReservedPendingSelfRoleApplicationsV2,
  getPendingSelfRoleRenewalSessionByGrant,
  getActiveSelfRoleSystemAlertByGrantType,
} = require('../../../core/utils/database');

const { refreshActiveUserSelfRolePanels } = require('../services/panelService');
const { checkExpiredSelfRoleApplications } = require('../services/applicationChecker');
const { runSelfRoleLifecycleTick } = require('../services/lifecycleScheduler');
const { runSelfRoleConsistencyCheck } = require('../services/consistencyChecker');
const { withRetry } = require('../../roleSync/utils/networkRetry');

function formatDateTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return String(ts);
  }
}

function formatMs(ms) {
  if (ms == null) return 'null';
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  return `${n}（${formatDateTime(n)}）`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 通过 REST API 分页扫描全服成员，并筛选拥有指定身份组的成员ID。
 *
 * 背景：在超大服务器（20万+）使用 `guild.members.fetch()` 会触发全量缓存/超时/内存问题。
 * 该实现复用 RoleSync 模块已验证的方案：`guild.members.list({ limit, after, cache:false })`。
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 * @param {{ includeBots?: boolean, onProgress?: (p: { scanned: number, pages: number, matched: number, skippedBots: number }) => (void|Promise<void>), signal?: { shouldStop: boolean } }} options
 * @returns {Promise<{ userIds: string[], scanned: number, pages: number, matched: number, skippedBots: number, aborted: boolean }>}
 */
async function listGuildRoleMemberIdsViaREST(guild, roleId, options = {}) {
  const includeBots = options.includeBots === true;
  const onProgress = options.onProgress || (() => {});
  const signal = options.signal || { shouldStop: false };

  const PAGE_SIZE = 1000;
  let afterCursor = '0';
  let scanned = 0;
  let pages = 0;
  let skippedBots = 0;

  const userIds = new Set();

  while (true) {
    if (signal.shouldStop) {
      return {
        userIds: [...userIds],
        scanned,
        pages,
        matched: userIds.size,
        skippedBots,
        aborted: true,
      };
    }

    const members = await withRetry(
      () => guild.members.list({ limit: PAGE_SIZE, after: afterCursor, cache: false }),
      { retries: 3, baseDelayMs: 1000, label: `selfrole_rest_list_members_${guild.id}_page${pages}` },
    );

    if (!members || members.size === 0) break;

    scanned += members.size;

    for (const [, member] of members) {
      // 优先使用 member._roles（更轻量，不需要为每个成员构建 roles.cache Collection）
      let hasRole = false;
      if (Array.isArray(member?._roles)) {
        hasRole = member._roles.includes(roleId);
      } else if (member?.roles?.cache?.has) {
        hasRole = member.roles.cache.has(roleId);
      }

      if (!hasRole) continue;

      if (!includeBots && member.user?.bot) {
        skippedBots += 1;
        continue;
      }

      userIds.add(member.id);
    }

    pages += 1;
    await Promise.resolve(onProgress({ scanned, pages, matched: userIds.size, skippedBots }));

    afterCursor = members.lastKey();
    if (members.size < PAGE_SIZE) break;

    await sleep(200);
  }

  return {
    userIds: [...userIds],
    scanned,
    pages,
    matched: userIds.size,
    skippedBots,
    aborted: false,
  };
}

async function buildLifecycleDebugSummary({ client, guildId, roleId, grant }) {
  const settings = await getSelfRoleSettings(guildId).catch(() => null);
  const roleConfig = settings?.roles?.find((r) => r?.roleId === roleId) || null;
  const lc = roleConfig?.lifecycle || {};

  const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
  const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
  const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId).catch(() => 0);
  const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, Date.now()).catch(() => 0);
  const full = hasLimit ? holders + pendingReserved >= maxMembers : true;

  const pendingSession = grant ? await getPendingSelfRoleRenewalSessionByGrant(grant.grantId).catch(() => null) : null;
  const dmAlert = grant ? await getActiveSelfRoleSystemAlertByGrantType(grant.grantId, 'lifecycle_dm_inquiry_failed').catch(() => null) : null;

  return {
    roleConfig,
    lifecycle: {
      enabled: !!lc.enabled,
      inquiryDays: lc.inquiryDays ?? null,
      forceRemoveDays: lc.forceRemoveDays ?? null,
      onlyWhenFull: !!lc.onlyWhenFull,
      reportChannelId: lc.reportChannelId || null,
    },
    capacity: {
      maxMembers: hasLimit ? maxMembers : null,
      holders,
      pendingReserved,
      full,
    },
    pendingSession,
    dmAlert,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('自助身份组申请-运维')
    .setDescription('【运维】SelfRole 手动触发/诊断工具（仅管理员/指定管理组可用）')
    .setDMPermission(false)

    // 1) 面板
    .addSubcommand((sub) =>
      sub
        .setName('刷新面板')
        .setDescription('立即刷新本服务器用户面板的岗位状态区（现任/空缺/待审核）'),
    )

    // 1.5) 同步身份组名单 -> grant（用于校准名额/生命周期口径）
    .addSubcommand((sub) =>
      sub
        .setName('同步身份组名单')
        .setDescription('读取服务器内指定身份组的成员名单，并同步为 SelfRole grant（会影响名额统计/周期清退）')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要同步的身份组（必须已配置为可自助申请岗位）')
            .setRequired(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('结束缺失grant')
            .setDescription('是否结束“数据库里有 active grant，但成员已不在该身份组内”的记录（需要完整成员列表）')
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('包含配套身份组')
            .setDescription('导入 grant 时是否同时记录该岗位的配套身份组（仅影响后续清退/退出时移除哪些角色）')
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('包含机器人')
            .setDescription('是否包含机器人账号（默认跳过）')
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('确认执行')
            .setDescription('true=实际写入数据库；false=仅预览将要变更的数量')
            .setRequired(false),
        ),
    )

    // 2) 申请过期
    .addSubcommand((sub) =>
      sub
        .setName('检查申请过期')
        .setDescription('立即执行一次 pending 申请过期扫描（默认 7 天过期释放名额）'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('强制过期申请')
        .setDescription('将某用户对某身份组的 pending 申请强制设置为“已到期”，并立刻执行过期扫描')
        .addUserOption((opt) =>
          opt
            .setName('目标用户')
            .setDescription('申请人')
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('申请的身份组')
            .setRequired(true),
        ),
    )

    // 3) 生命周期
    .addSubcommand((sub) =>
      sub
        .setName('执行生命周期')
        .setDescription('立即执行一次 grant 生命周期 tick（询问/强制清退/onlyWhenFull 逻辑）'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('立即触发询问')
        .setDescription('将某用户的某岗位 grant 设为“询问已到期”，并立刻执行生命周期 tick')
        .addUserOption((opt) =>
          opt
            .setName('目标用户')
            .setDescription('grant 目标用户')
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('grant 的主身份组')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('立即触发强制清退')
        .setDescription('将某用户的某岗位 grant 设为“强制清退已到期”，并立刻执行生命周期 tick')
        .addUserOption((opt) =>
          opt
            .setName('目标用户')
            .setDescription('grant 目标用户')
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('grant 的主身份组')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('查看grant')
        .setDescription('查看某用户对某岗位的 active grant 详情（仅 bot 发放才会有记录）')
        .addUserOption((opt) =>
          opt
            .setName('目标用户')
            .setDescription('grant 目标用户')
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('grant 的主身份组')
            .setRequired(true),
        ),
    )

    // 4) 一致性巡检
    .addSubcommand((sub) =>
      sub
        .setName('执行一致性巡检')
        .setDescription('立即执行一次一致性巡检（面板丢失/结束grant角色残留等）'),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ 此命令只能在服务器中使用。', ephemeral: true }).catch(() => {});
      return;
    }

    if (!checkAdminPermission(interaction.member)) {
      await interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true }).catch(() => {});
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const now = Date.now();

    // --- 面板 ---
    if (sub === '刷新面板') {
      await refreshActiveUserSelfRolePanels(interaction.client, guildId);
      await interaction.editReply({ content: '✅ 已触发用户面板刷新。' });
      return;
    }

    // --- 同步身份组名单 -> grant ---
    if (sub === '同步身份组名单') {
      const role = interaction.options.getRole('目标身份组', true);
      const endMissingGrant = interaction.options.getBoolean('结束缺失grant') ?? false;
      const includeBundle = interaction.options.getBoolean('包含配套身份组') ?? false;
      const includeBots = interaction.options.getBoolean('包含机器人') ?? false;
      const confirm = interaction.options.getBoolean('确认执行') ?? false;

      const settings = await getSelfRoleSettings(guildId).catch(() => null);
      const roleConfig = settings?.roles?.find((r) => r?.roleId === role.id) || null;
      if (!roleConfig) {
        await interaction.editReply({
          content:
            `❌ 该身份组未配置为“可自助申请岗位”，无法同步为 grant：<@&${role.id}>\n\n` +
            `请先使用 /自助身份组申请-配置向导 或 /自助身份组申请-配置身份组 完成岗位配置。`,
        });
        return;
      }

      await interaction.editReply({
        content: '🔄 正在通过 REST 分页扫描全服成员并筛选身份组名单...（大服务器可能需要较长时间）',
      });

      const scanStartedAt = Date.now();
      let scanErrText = '';
      let scanResult = null;
      let lastProgressUpdateAt = 0;
      try {
        scanResult = await listGuildRoleMemberIdsViaREST(interaction.guild, role.id, {
          includeBots,
          onProgress: async ({ scanned, pages, matched, skippedBots: currentSkippedBots }) => {
            const ts = Date.now();
            const shouldUpdate = pages <= 1 || ts - lastProgressUpdateAt >= 5000 || pages % 25 === 0;
            if (!shouldUpdate) return;
            lastProgressUpdateAt = ts;

            const botText = includeBots ? '' : ` skippedBots=${currentSkippedBots}`;
            await interaction
              .editReply({
                content:
                  `🔄 正在扫描成员并筛选身份组：<@&${role.id}>\n` +
                  `进度：pages=${pages} scanned=${scanned}/${interaction.guild.memberCount} matched=${matched}${botText}`,
              })
              .catch(() => {});
          },
        });
      } catch (err) {
        scanErrText = err?.message ? String(err.message) : String(err);
      }

      if (!scanResult) {
        await interaction.editReply({
          content:
            `❌ 通过 REST 扫描服务器成员失败，无法统计身份组名单：<@&${role.id}>\n\n` +
            (scanErrText ? `error=${scanErrText}\n\n` : '') +
            `建议：\n- 稍后重试（可能遇到短暂网络/Discord API 抖动）\n- 检查机器人是否能正常访问该服务器`,
        });
        return;
      }

      const scanDurationMs = Date.now() - scanStartedAt;
      const scanCompleted = !scanResult.aborted;
      const userIdsInRole = Array.isArray(scanResult.userIds) ? scanResult.userIds : [];
      const skippedBots = Number(scanResult.skippedBots || 0);
      const scannedMembers = Number(scanResult.scanned || 0);
      const scannedPages = Number(scanResult.pages || 0);
      const inSet = new Set(userIdsInRole);

      const existingGrants = await listActiveSelfRoleGrantsByPrimaryRole(guildId, role.id).catch(() => []);
      const grantSet = new Set(existingGrants.map((g) => g.userId));

      const toCreate = [...inSet].filter((uid) => !grantSet.has(uid));
      const toEnd = [...grantSet].filter((uid) => !inSet.has(uid));

      if (endMissingGrant && !scanCompleted) {
        await interaction.editReply({
          content:
            `❌ 本次未完成全量成员扫描，因此为避免误结束 grant，本次禁止执行“结束缺失grant”。\n\n` +
            `scanned=${scannedMembers}/${interaction.guild.memberCount} pages=${scannedPages}\n` +
            (scanErrText ? `error=${scanErrText}\n\n` : '\n') +
            `建议：\n- 稍后重试\n- 或先关闭“结束缺失grant”，仅做导入/补齐`,
        });
        return;
      }

      const sampleCreate = toCreate.slice(0, 10).map((id) => `<@${id}>`).join(' ');
      const sampleEnd = toEnd.slice(0, 10).map((id) => `<@${id}>`).join(' ');

      const bundleRoleIds = includeBundle ? (Array.isArray(roleConfig.bundleRoleIds) ? roleConfig.bundleRoleIds : []) : [];
      const bundleText = includeBundle
        ? (bundleRoleIds.length > 0 ? bundleRoleIds.map((rid) => `<@&${rid}>`).join(' ') : '（无）')
        : '（不记录配套身份组）';

      const previewLines = [
        `目标身份组：<@&${role.id}>`,
        '扫描方式：REST 分页 list（cache:false）',
        `扫描结果：${scanCompleted ? '✅ 已完成' : '⚠️ 未完成（aborted）'}`,
        `扫描统计：scanned=${scannedMembers}/${interaction.guild.memberCount} pages=${scannedPages} 耗时≈${Math.round(scanDurationMs / 1000)} 秒`,
        includeBots ? '包含机器人：是' : `包含机器人：否（已跳过 bots=${skippedBots}）`,
        `现有 active grants：${existingGrants.length}`,
        `身份组成员数（基于扫描）：${inSet.size}`,
        `将新增 grants：${toCreate.length}${sampleCreate ? `\n- 示例：${sampleCreate}${toCreate.length > 10 ? ' ...' : ''}` : ''}`,
        endMissingGrant
          ? `将结束 grants（成员已不在该身份组内）：${toEnd.length}${sampleEnd ? `\n- 示例：${sampleEnd}${toEnd.length > 10 ? ' ...' : ''}` : ''}`
          : `将结束 grants：0（未启用“结束缺失grant”）`,
        `同步配套身份组：${includeBundle ? '是' : '否'}\n- 配套身份组：${bundleText}`,
        '',
        confirm
          ? '✅ 已确认执行：将开始写入数据库。'
          : '⚠️ 当前为预览模式：如需执行，请重新运行并设置 `确认执行:true`。',
        '',
        '注意：导入为 grant 后，这些成员会被系统视为“本模块管理对象”，将计入名额统计，并可能触发周期询问/清退（若该岗位启用了 lifecycle）。',
      ].filter(Boolean);

      if (!confirm) {
        await interaction.editReply({ content: previewLines.join('\n') });
        return;
      }

      // 执行写入
      const startedAt = Date.now();
      let created = 0;
      let createFailed = 0;
      let ended = 0;
      let endFailed = 0;

      for (const uid of toCreate) {
        try {
          await createSelfRoleGrant({
            guildId,
            userId: uid,
            primaryRoleId: role.id,
            applicationId: null,
            grantedAt: now,
            bundleRoleIds,
          });
          created++;
        } catch (_) {
          createFailed++;
        }
      }

      if (endMissingGrant) {
        for (const uid of toEnd) {
          try {
            const c = await endActiveSelfRoleGrantsForUserRole(guildId, uid, role.id, 'sync_missing_role', now);
            if (c && c > 0) ended += c;
          } catch (_) {
            endFailed++;
          }
        }
      }

      await refreshActiveUserSelfRolePanels(interaction.client, guildId).catch(() => {});

      const durationMs = Date.now() - startedAt;
      await interaction.editReply({
        content:
          `✅ 同步完成：<@&${role.id}>\n` +
          `新增 grants：${created}\n` +
          (createFailed > 0 ? `新增失败：${createFailed}\n` : '') +
          (endMissingGrant ? `结束 grants：${ended}\n` : '') +
          (endFailed > 0 ? `结束失败：${endFailed}\n` : '') +
          `耗时：${Math.round(durationMs / 1000)} 秒\n\n` +
          `已触发用户面板刷新。`,
      });
      return;
    }

    // --- 申请过期 ---
    if (sub === '检查申请过期') {
      const expired = await checkExpiredSelfRoleApplications(interaction.client);
      const count = Array.isArray(expired) ? expired.length : 0;
      await interaction.editReply({ content: `✅ 已执行过期扫描，本次过期处理：${count} 条。` });
      return;
    }

    if (sub === '强制过期申请') {
      const user = interaction.options.getUser('目标用户', true);
      const role = interaction.options.getRole('目标身份组', true);

      const pending = await getPendingSelfRoleApplicationV2ByApplicantRole(guildId, user.id, role.id);
      if (!pending) {
        await interaction.editReply({ content: '❌ 未找到该用户对该身份组的 pending v2 申请。' });
        return;
      }

      await saveSelfRoleApplicationV2(pending.applicationId, {
        guildId: pending.guildId,
        applicantId: pending.applicantId,
        roleId: pending.roleId,
        status: 'pending',
        reason: pending.reason,
        reviewMessageId: pending.reviewMessageId,
        reviewChannelId: pending.reviewChannelId,
        slotReserved: true,
        reservedUntil: now - 1,
        createdAt: pending.createdAt,
        resolvedAt: pending.resolvedAt,
        resolutionReason: pending.resolutionReason,
      });

      const expired = await checkExpiredSelfRoleApplications(interaction.client);
      const hit = Array.isArray(expired) ? expired.find((a) => a && a.applicationId === pending.applicationId) : null;

      await interaction.editReply({
        content: hit
          ? `✅ 已强制过期并完成处理：applicationId=${pending.applicationId}`
          : `✅ 已设置 reserved_until 为过去并执行扫描（applicationId=${pending.applicationId}）。若未立即处理，请检查该申请是否仍为 pending/slot_reserved=1。`,
      });
      return;
    }

    // --- 生命周期 ---
    if (sub === '执行生命周期') {
      const tick = await runSelfRoleLifecycleTick(interaction.client, { guildId });
      const hint = tick?.skipped ? `⚠️ tick 未执行：reason=${tick.reason || 'unknown'}（可能正在执行中）。` : '';
      await interaction.editReply({
        content:
          `✅ 已执行一次生命周期 tick（仅当前服务器）。\n` +
          (hint ? `${hint}\n` : '') +
          `summary: due=${tick?.dueGrants ?? '?'} inquiry=${tick?.processedInquiries ?? '?'} force=${tick?.processedForceRemoves ?? '?'} skippedOnlyWhenFull=${tick?.skippedOnlyWhenFull ?? '?'} errors=${tick?.errors ?? '?'}`,
      });
      return;
    }

    if (sub === '立即触发询问' || sub === '立即触发强制清退' || sub === '查看grant') {
      const user = interaction.options.getUser('目标用户', true);
      const role = interaction.options.getRole('目标身份组', true);

      const grant = await getActiveSelfRoleGrantByUserRole(guildId, user.id, role.id);
      if (!grant) {
        await interaction.editReply({ content: '❌ 未找到该用户对该身份组的 active grant（仅 bot 发放才会有 grant）。' });
        return;
      }

      if (sub === '查看grant') {
        const roles = await listSelfRoleGrantRoles(grant.grantId);
        const roleText = roles.length > 0 ? roles.map((r) => `<@&${r.roleId}>(${r.roleKind})`).join(' ') : '（无）';

        await interaction.editReply({
          content:
            `grantId: ${grant.grantId}\n` +
            `user: <@${grant.userId}>\n` +
            `primaryRole: <@&${grant.primaryRoleId}>\n` +
            `status: ${grant.status}\n` +
            `grantedAt: ${formatMs(grant.grantedAt)}\n` +
            `nextInquiryAt: ${formatMs(grant.nextInquiryAt)}\n` +
            `forceRemoveAt: ${formatMs(grant.forceRemoveAt)}\n` +
            `manualAttentionRequired: ${grant.manualAttentionRequired ? 'true' : 'false'}\n` +
            `roles: ${roleText}`,
        });
        return;
      }

      if (sub === '立即触发询问') {
        await updateSelfRoleGrantSchedule(grant.grantId, {
          nextInquiryAt: now - 1,
          forceRemoveAt: grant.forceRemoveAt,
        });

        const before = await getActiveSelfRoleGrantByUserRole(guildId, user.id, role.id).catch(() => null);
        const tick = await runSelfRoleLifecycleTick(interaction.client, { guildId, grantId: grant.grantId });
        const after = await getActiveSelfRoleGrantByUserRole(guildId, user.id, role.id).catch(() => null);

        const dbg = await buildLifecycleDebugSummary({ client: interaction.client, guildId, roleId: role.id, grant: after || grant });

        let hint = '';
        if (tick?.skipped) {
          hint = `⚠️ 生命周期 tick 未执行：reason=${tick.reason || 'unknown'}（可能正在执行中）。`;
        }
        if (!dbg.lifecycle.enabled) {
          hint = '⚠️ lifecycle 未启用：tick 会跳过该 grant。';
        } else if (dbg.lifecycle.onlyWhenFull && dbg.capacity.maxMembers && !dbg.capacity.full) {
          hint = '⚠️ onlyWhenFull=是 且当前未满员：tick 会跳过询问（计时会继续）。';
        } else if (dbg.pendingSession) {
          hint = `⚠️ 存在未完成的 pending 询问 session：sessionId=${dbg.pendingSession.sessionId}，tick 将跳过重复发送。`;
        }

        await interaction.editReply({
          content:
            `✅ 已将 nextInquiryAt 设为过去并执行 tick：grantId=${grant.grantId}\n\n` +
            `tickSummary: skipped=${tick?.skipped ? 'true' : 'false'} due=${tick?.dueGrants ?? '?'} inquiry=${tick?.processedInquiries ?? '?'} force=${tick?.processedForceRemoves ?? '?'} errors=${tick?.errors ?? '?'}\n\n` +
            (hint ? `${hint}\n\n` : '') +
            `【grant 调度字段】\n` +
            `before.nextInquiryAt: ${formatMs(before?.nextInquiryAt)}\n` +
            `after.nextInquiryAt:  ${formatMs(after?.nextInquiryAt)}\n` +
            `after.lastInquiryAt:  ${formatMs(after?.lastInquiryAt)}\n` +
            `after.manualAttentionRequired: ${after?.manualAttentionRequired ? 'true' : 'false'}\n\n` +
            `【生命周期配置】enabled=${dbg.lifecycle.enabled ? 'true' : 'false'} onlyWhenFull=${dbg.lifecycle.onlyWhenFull ? 'true' : 'false'} reportChannel=${dbg.lifecycle.reportChannelId ? `<#${dbg.lifecycle.reportChannelId}>` : '（未配置）'}\n` +
            `【容量口径（仅 grant 记忆）】max=${dbg.capacity.maxMembers ?? '∞'} holders=${dbg.capacity.holders} pending=${dbg.capacity.pendingReserved} full=${dbg.capacity.full ? 'true' : 'false'}\n\n` +
            `【DM 失败告警】${dbg.dmAlert ? `active alertId=${dbg.dmAlert.alertId}` : '（无）'}`,
        });
        return;
      }

      if (sub === '立即触发强制清退') {
        await updateSelfRoleGrantSchedule(grant.grantId, {
          nextInquiryAt: grant.nextInquiryAt,
          forceRemoveAt: now - 1,
        });

        const tick = await runSelfRoleLifecycleTick(interaction.client, { guildId, grantId: grant.grantId });

        await interaction.editReply({
          content:
            `✅ 已将 forceRemoveAt 设为过去并执行 tick：grantId=${grant.grantId}\n\n` +
            `tickSummary: skipped=${tick?.skipped ? 'true' : 'false'} reason=${tick?.reason || 'ok'} due=${tick?.dueGrants ?? '?'} inquiry=${tick?.processedInquiries ?? '?'} force=${tick?.processedForceRemoves ?? '?'} errors=${tick?.errors ?? '?'}`,
        });
        return;
      }
    }

    // --- 一致性巡检 ---
    if (sub === '执行一致性巡检') {
      await runSelfRoleConsistencyCheck(interaction.client);
      await interaction.editReply({ content: '✅ 已执行一次一致性巡检。' });
      return;
    }

    await interaction.editReply({ content: '❌ 未识别的运维子命令。' });
  },
};
