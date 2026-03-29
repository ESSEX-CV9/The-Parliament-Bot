// src/modules/selfRole/commands/selfRoleTest.js
//
// 注意：该文件为“测试/运维辅助命令”。
// 正式上线建议通过环境变量关闭命令注册（见 src/core/index.js 中的 gated register）。

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const {
  getPendingSelfRoleApplicationV2ByApplicantRole,
  saveSelfRoleApplicationV2,
  getSelfRoleSettings,
  getActiveSelfRoleGrantByUserRole,
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
    .setName('自助身份组申请-测试')
    .setDescription('【测试/运维】SelfRole 快速测试与手动触发工具（生产环境请关闭注册）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // 1) 面板
    .addSubcommand((sub) =>
      sub
        .setName('刷新面板')
        .setDescription('立即刷新本服务器用户面板的岗位状态区（现任/空缺/待审核）'),
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
        .setDescription('查看某用户对某岗位的 active grant 详情')
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
    // 双保险：就算被注册了，仍可通过环境变量做运行时熔断
    if (String(process.env.SELF_ROLE_ENABLE_TEST_COMMANDS || '').toLowerCase() !== 'true') {
      await interaction.reply({
        content: '❌ 测试命令未启用。请设置环境变量 SELF_ROLE_ENABLE_TEST_COMMANDS=true 后重启机器人（仅测试环境建议开启）。',
        ephemeral: true,
      });
      return;
    }

    if (!checkAdminPermission(interaction.member)) {
      await interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
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
      await runSelfRoleLifecycleTick(interaction.client);
      await interaction.editReply({ content: '✅ 已执行一次生命周期 tick。' });
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
        await runSelfRoleLifecycleTick(interaction.client);
        await interaction.editReply({ content: `✅ 已将 forceRemoveAt 设为过去并执行 tick：grantId=${grant.grantId}` });
        return;
      }
    }

    // --- 一致性巡检 ---
    if (sub === '执行一致性巡检') {
      await runSelfRoleConsistencyCheck(interaction.client);
      await interaction.editReply({ content: '✅ 已执行一次一致性巡检。' });
      return;
    }

    await interaction.editReply({ content: '❌ 未识别的测试子命令。' });
  },
};
