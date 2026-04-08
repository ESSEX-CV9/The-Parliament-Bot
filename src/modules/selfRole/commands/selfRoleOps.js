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

function extractRoleIdsFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const ids = raw.match(/\d{17,20}/g) || [];
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}

function formatRoleMentionList(roleIds, limit = 10) {
  const ids = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  const shown = ids.slice(0, limit).map((rid) => `<@&${rid}>`).join(' ');
  if (ids.length > limit) return `${shown} ...（+${ids.length - limit}）`;
  return shown || '（无）';
}

/**
 * 通过 REST API 分页扫描全服成员，并为每个目标身份组筛选成员ID（一次扫描支持多个身份组）。
 *
 * 背景：在超大服务器（20万+）使用 `guild.members.fetch()` 会触发全量缓存/超时/内存问题。
 * 该实现复用 RoleSync 模块已验证的方案：`guild.members.list({ limit, after, cache:false })`。
 *
 * @param {import('discord.js').Guild} guild
 * @param {string[]} roleIds
 * @param {{ includeBots?: boolean, onProgress?: (p: { scanned: number, pages: number, matchedTotal: number, matchedByRole: Record<string, number>, skippedBots: number }) => (void|Promise<void>), signal?: { shouldStop: boolean } }} options
 * @returns {Promise<{ roleMemberSets: Map<string, Set<string>>, scanned: number, pages: number, matchedTotal: number, skippedBots: number, aborted: boolean }>}
 */
async function listGuildRoleMemberIdsByRolesViaREST(guild, roleIds, options = {}) {
  const includeBots = options.includeBots === true;
  const onProgress = options.onProgress || (() => {});
  const signal = options.signal || { shouldStop: false };

  const pickedRoleIds = [...new Set((Array.isArray(roleIds) ? roleIds : []).filter(Boolean))];
  const targetRoleSet = new Set(pickedRoleIds);
  const roleMemberSets = new Map();
  for (const rid of pickedRoleIds) {
    roleMemberSets.set(rid, new Set());
  }

  const PAGE_SIZE = 1000;
  let afterCursor = '0';
  let scanned = 0;
  let pages = 0;
  let skippedBots = 0;
  let matchedTotal = 0;

  while (true) {
    if (signal.shouldStop) {
      return {
        roleMemberSets,
        scanned,
        pages,
        matchedTotal,
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
      const roles = Array.isArray(member?._roles)
        ? member._roles
        : (member?.roles?.cache ? [...member.roles.cache.keys()] : []);

      let matchedAny = false;
      for (const rid of roles) {
        if (!targetRoleSet.has(rid)) continue;
        matchedAny = true;

        if (!includeBots && member.user?.bot) {
          continue;
        }

        const set = roleMemberSets.get(rid);
        if (!set) continue;

        if (!set.has(member.id)) {
          set.add(member.id);
          matchedTotal += 1;
        }
      }

      if (!includeBots && member.user?.bot && matchedAny) {
        skippedBots += 1;
      }
    }

    pages += 1;

    const matchedByRole = {};
    for (const rid of pickedRoleIds) {
      matchedByRole[rid] = roleMemberSets.get(rid)?.size || 0;
    }
    await Promise.resolve(onProgress({ scanned, pages, matchedTotal, matchedByRole, skippedBots }));

    afterCursor = members.lastKey();
    if (members.size < PAGE_SIZE) break;

    await sleep(200);
  }

  return {
    roleMemberSets,
    scanned,
    pages,
    matchedTotal,
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
            .setDescription('要同步的身份组（单个；若要多个请使用“目标身份组列表”）')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('目标身份组列表')
            .setDescription('要同步的身份组列表（粘贴 @身份组 或 ID，多个用空格/逗号/换行分隔）')
            .setRequired(false),
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
      const singleRole = interaction.options.getRole('目标身份组');
      const roleListText = interaction.options.getString('目标身份组列表');
      const endMissingGrant = interaction.options.getBoolean('结束缺失grant') ?? false;
      const includeBundle = interaction.options.getBoolean('包含配套身份组') ?? false;
      const includeBots = interaction.options.getBoolean('包含机器人') ?? false;
      const confirm = interaction.options.getBoolean('确认执行') ?? false;

      if (singleRole && roleListText) {
        await interaction.editReply({
          content: '❌ 请只填写“目标身份组”或“目标身份组列表”其一（不要同时填写）。',
        });
        return;
      }

      const settings = await getSelfRoleSettings(guildId).catch(() => null);
      const configuredRoleIds = new Set((settings?.roles || []).map((r) => r?.roleId).filter(Boolean));

      let targetRoleIds = [];
      if (roleListText) {
        const picked = extractRoleIdsFromText(roleListText);
        if (picked.length === 0) {
          await interaction.editReply({
            content: '❌ “目标身份组列表”未解析到任何身份组ID，请粘贴 @身份组 或 18~20 位 roleId。',
          });
          return;
        }

        const invalid = picked.filter((rid) => !configuredRoleIds.has(rid));
        if (invalid.length > 0) {
          await interaction.editReply({
            content:
              `❌ 你提供的身份组列表中，存在未配置为“可自助申请岗位”的身份组，无法同步：\n` +
              `${formatRoleMentionList(invalid, 20)}\n\n` +
              `请先使用 /自助身份组申请-配置向导 或 /自助身份组申请-配置身份组 完成岗位配置，或将其从列表移除。`,
          });
          return;
        }

        targetRoleIds = picked;
      } else if (singleRole) {
        if (!configuredRoleIds.has(singleRole.id)) {
          await interaction.editReply({
            content:
              `❌ 该身份组未配置为“可自助申请岗位”，无法同步为 grant：<@&${singleRole.id}>\n\n` +
              `请先使用 /自助身份组申请-配置向导 或 /自助身份组申请-配置身份组 完成岗位配置。`,
          });
          return;
        }
        targetRoleIds = [singleRole.id];
      } else {
        await interaction.editReply({
          content: '❌ 请填写 “目标身份组”（单个）或 “目标身份组列表”（多个）。',
        });
        return;
      }

      targetRoleIds = [...new Set(targetRoleIds.filter(Boolean))];

      const MAX_ROLES = 20;
      if (targetRoleIds.length > MAX_ROLES) {
        await interaction.editReply({
          content: `❌ 本次同步的身份组数量过多（${targetRoleIds.length}），为避免输出过长与误操作，最多允许 ${MAX_ROLES} 个。`,
        });
        return;
      }

      const roleConfigById = new Map();
      for (const r of settings?.roles || []) {
        if (r?.roleId) roleConfigById.set(r.roleId, r);
      }

      await interaction.editReply({
        content:
          '🔄 正在通过 REST 分页扫描全服成员并筛选身份组名单...（大服务器可能需要较长时间）\n' +
          `目标（${targetRoleIds.length}）：${formatRoleMentionList(targetRoleIds, 6)}`,
      });

      const scanStartedAt = Date.now();
      let scanErrText = '';
      let scanResult = null;
      let lastProgressUpdateAt = 0;

      try {
        scanResult = await listGuildRoleMemberIdsByRolesViaREST(interaction.guild, targetRoleIds, {
          includeBots,
          onProgress: async ({ scanned, pages, matchedTotal, matchedByRole, skippedBots: currentSkippedBots }) => {
            const ts = Date.now();
            const shouldUpdate = pages <= 1 || ts - lastProgressUpdateAt >= 5000 || pages % 25 === 0;
            if (!shouldUpdate) return;
            lastProgressUpdateAt = ts;

            const botText = includeBots ? '' : ` skippedBots=${currentSkippedBots}`;
            const sampleRoleIds = targetRoleIds.slice(0, 4);
            const sampleCounts = sampleRoleIds
              .map((rid) => `<@&${rid}>:${matchedByRole?.[rid] ?? 0}`)
              .join(' ');
            const sampleSuffix = targetRoleIds.length > sampleRoleIds.length
              ? ` ...（+${targetRoleIds.length - sampleRoleIds.length}）`
              : '';

            await interaction
              .editReply({
                content:
                  `🔄 正在扫描成员并筛选身份组（${targetRoleIds.length} 个）\n` +
                  `目标：${formatRoleMentionList(targetRoleIds, 3)}\n` +
                  `进度：pages=${pages} scanned=${scanned}/${interaction.guild.memberCount} matchedTotal=${matchedTotal}${botText}\n` +
                  `匹配示例：${sampleCounts}${sampleSuffix}`,
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
            `❌ 通过 REST 扫描服务器成员失败，无法统计身份组名单。\n\n` +
            (scanErrText ? `error=${scanErrText}\n\n` : '') +
            `建议：\n- 稍后重试（可能遇到短暂网络/Discord API 抖动）\n- 检查机器人是否能正常访问该服务器`,
        });
        return;
      }

      const scanDurationMs = Date.now() - scanStartedAt;
      const scanCompleted = !scanResult.aborted;
      const skippedBots = Number(scanResult.skippedBots || 0);
      const scannedMembers = Number(scanResult.scanned || 0);
      const scannedPages = Number(scanResult.pages || 0);
      const matchedTotal = Number(scanResult.matchedTotal || 0);

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

      const showSamples = targetRoleIds.length <= 5;
      const showBundleDetails = includeBundle && targetRoleIds.length <= 10;

      const diffs = [];
      let totalExisting = 0;
      let totalToCreate = 0;
      let totalToEnd = 0;

      for (const roleId of targetRoleIds) {
        const inSet = scanResult.roleMemberSets.get(roleId) || new Set();
        const existingGrants = await listActiveSelfRoleGrantsByPrimaryRole(guildId, roleId).catch(() => []);
        const grantSet = new Set(existingGrants.map((g) => g.userId));

        const toCreate = [];
        for (const uid of inSet) {
          if (!grantSet.has(uid)) toCreate.push(uid);
        }

        const toEnd = [];
        if (endMissingGrant) {
          for (const uid of grantSet) {
            if (!inSet.has(uid)) toEnd.push(uid);
          }
        }

        const roleConfig = roleConfigById.get(roleId) || null;
        const bundleRoleIds = includeBundle
          ? (Array.isArray(roleConfig?.bundleRoleIds) ? roleConfig.bundleRoleIds : [])
          : [];

        totalExisting += existingGrants.length;
        totalToCreate += toCreate.length;
        if (endMissingGrant) totalToEnd += toEnd.length;

        diffs.push({
          roleId,
          inSet,
          existingGrants,
          toCreate,
          toEnd,
          bundleRoleIds,
        });
      }

      const previewLines = [
        `目标身份组数：${targetRoleIds.length}`,
        `目标身份组：${formatRoleMentionList(targetRoleIds, 10)}`,
        '扫描方式：REST 分页 list（cache:false）',
        `扫描结果：${scanCompleted ? '✅ 已完成' : '⚠️ 未完成（aborted）'}`,
        `扫描统计：scanned=${scannedMembers}/${interaction.guild.memberCount} pages=${scannedPages} matchedTotal=${matchedTotal} 耗时≈${Math.round(scanDurationMs / 1000)} 秒`,
        includeBots ? '包含机器人：是' : `包含机器人：否（已跳过 bots=${skippedBots}）`,
        `现有 active grants（总计）：${totalExisting}`,
        `将新增 grants（总计）：${totalToCreate}`,
        endMissingGrant ? `将结束 grants（总计）：${totalToEnd}` : '将结束 grants（总计）：0（未启用“结束缺失grant”）',
        '',
        '【按身份组】',
      ];

      for (const item of diffs) {
        previewLines.push(
          `- <@&${item.roleId}> members=${item.inSet.size} grants=${item.existingGrants.length} add=${item.toCreate.length}` +
            (endMissingGrant ? ` end=${item.toEnd.length}` : ''),
        );

        if (showBundleDetails) {
          previewLines.push(
            `  - 配套身份组：${item.bundleRoleIds.length > 0 ? formatRoleMentionList(item.bundleRoleIds, 12) : '（无）'}`,
          );
        }

        if (showSamples) {
          const sampleCreate = item.toCreate.slice(0, 5).map((id) => `<@${id}>`).join(' ');
          if (sampleCreate) {
            previewLines.push(`  - add 示例：${sampleCreate}${item.toCreate.length > 5 ? ' ...' : ''}`);
          }

          if (endMissingGrant) {
            const sampleEnd = item.toEnd.slice(0, 5).map((id) => `<@${id}>`).join(' ');
            if (sampleEnd) {
              previewLines.push(`  - end 示例：${sampleEnd}${item.toEnd.length > 5 ? ' ...' : ''}`);
            }
          }
        }
      }

      previewLines.push('');
      previewLines.push(
        confirm
          ? '✅ 已确认执行：将开始写入数据库。'
          : '⚠️ 当前为预览模式：如需执行，请重新运行并设置 `确认执行:true`。',
      );
      previewLines.push('');
      previewLines.push('注意：导入为 grant 后，这些成员会被系统视为“本模块管理对象”，将计入名额统计，并可能触发周期询问/清退（若该岗位启用了 lifecycle）。');

      if (!confirm) {
        await interaction.editReply({ content: previewLines.join('\n') });
        return;
      }

      // 执行写入
      const startedAt = Date.now();
      const perRoleWriteLines = [];
      let totalCreated = 0;
      let totalCreateFailed = 0;
      let totalEnded = 0;
      let totalEndFailed = 0;

      for (const item of diffs) {
        let created = 0;
        let createFailed = 0;
        let ended = 0;
        let endFailed = 0;

        for (const uid of item.toCreate) {
          try {
            await createSelfRoleGrant({
              guildId,
              userId: uid,
              primaryRoleId: item.roleId,
              applicationId: null,
              grantedAt: now,
              bundleRoleIds: item.bundleRoleIds,
            });
            created++;
          } catch (_) {
            createFailed++;
          }
        }

        if (endMissingGrant) {
          for (const uid of item.toEnd) {
            try {
              const c = await endActiveSelfRoleGrantsForUserRole(guildId, uid, item.roleId, 'sync_missing_role', now);
              if (c && c > 0) ended += c;
            } catch (_) {
              endFailed++;
            }
          }
        }

        totalCreated += created;
        totalCreateFailed += createFailed;
        totalEnded += ended;
        totalEndFailed += endFailed;

        const parts = [`- <@&${item.roleId}> 新增=${created}`];
        if (createFailed > 0) parts.push(`新增失败=${createFailed}`);
        if (endMissingGrant) {
          parts.push(`结束=${ended}`);
          if (endFailed > 0) parts.push(`结束失败=${endFailed}`);
        }
        perRoleWriteLines.push(parts.join(' '));
      }

      await refreshActiveUserSelfRolePanels(interaction.client, guildId).catch(() => {});

      const durationMs = Date.now() - startedAt;
      await interaction.editReply({
        content:
          `✅ 同步完成（${targetRoleIds.length} 个身份组）\n` +
          perRoleWriteLines.join('\n') +
          `\n\n总新增 grants：${totalCreated}${totalCreateFailed > 0 ? `（失败 ${totalCreateFailed}）` : ''}\n` +
          (endMissingGrant
            ? `总结束 grants：${totalEnded}${totalEndFailed > 0 ? `（失败 ${totalEndFailed}）` : ''}\n`
            : '') +
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
