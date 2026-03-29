// src/modules/selfRole/services/configWizardService.js
//
// 方案 1：配置向导（Wizard）
// - 目标：用一条命令 + 多步交互，一次性完成某身份组的自助申请配置。
// - 交互形态：按钮 / 角色选择 / 频道选择 / Modal 输入
// - 状态保存：进程内短期 session（向导属于短时交互，重启/超时会失效）
// - 鉴权：permissionManager.checkAdminPermission（服务器 owner / Administrator / ALLOWED_ROLE_IDS）

const { randomUUID } = require('crypto');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const {
  getSelfRoleSettings,
  saveSelfRoleSettings,
} = require('../../../core/utils/database');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { updateMonitoredChannels } = require('./activityTracker');
const { scheduleActiveUserSelfRolePanelsRefresh } = require('./panelService');

const WIZARD_SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

/** @type {Map<string, any>} */
const wizardSessions = new Map();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of wizardSessions.entries()) {
    if (!session || !session.expiresAt || now >= session.expiresAt) {
      wizardSessions.delete(id);
    }
  }
}

function parseCustomId(customId) {
  const raw = String(customId || '');
  if (!raw.startsWith('sr_wiz:')) return null;
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const sessionId = parts[1];
  const action = parts.slice(2).join(':');
  if (!sessionId || !action) return null;
  return { sessionId, action };
}

function extractChannelIdFromText(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // <#channelId>
  const mention = text.match(/^<#(\d{17,20})>$/);
  if (mention) return mention[1];

  // https://discord.com/channels/<guildId>/<channelId>/<messageId?>
  const link = text.match(/channels\/(\d{17,20})\/(\d{17,20})(?:\/(\d{17,20}))?/);
  if (link) return link[2];

  // pure id
  if (/^\d{17,20}$/.test(text)) return text;

  // fallback: pick the 2nd snowflake (guildId, channelId, messageId)
  const ids = text.match(/\d{17,20}/g);
  if (!ids || ids.length === 0) return null;
  if (ids.length >= 2) return ids[1];
  return ids[0];
}

function formatRoleMentions(roleIds) {
  const list = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  if (list.length === 0) return '（无）';
  return list.map((rid) => `<@&${rid}>`).join('，');
}

function formatChannelMention(channelId) {
  if (!channelId) return '（未配置）';
  return `<#${channelId}>`;
}

function buildWizardEmbed(session, stepTitle, stepIndex, stepTotal, lines = [], fields = []) {
  const embed = new EmbedBuilder()
    .setTitle(`🧭 配置向导（${stepIndex}/${stepTotal}）：${stepTitle}`)
    .setColor(0x5865F2)
    .addFields({
      name: '目标身份组',
      value: `<@&${session.roleId}>（\`${session.roleId}\`）`,
      inline: false,
    });

  if (Array.isArray(fields) && fields.length > 0) {
    embed.addFields(...fields);
  }

  const desc = (Array.isArray(lines) ? lines : []).filter(Boolean).join('\n');
  if (desc) {
    embed.setDescription(desc.length > 4096 ? desc.slice(0, 4093) + '…' : desc);
  }

  return embed;
}

function ensureApprovalObject(session) {
  if (!session.data.approval || typeof session.data.approval !== 'object') {
    session.data.approval = {
      channelId: null,
      requiredApprovals: null,
      requiredRejections: null,
      allowedVoterRoles: [],
      cooldownDays: null,
      dmTemplates: {},
    };
  }
}

function ensureNavStack(session) {
  if (!session) return;
  if (!session.navStack || !Array.isArray(session.navStack)) {
    session.navStack = [];
  }
}

function gotoStep(session, nextStep) {
  if (!session || !nextStep) return;
  ensureNavStack(session);

  if (session.step === nextStep) return;

  session.navStack.push(session.step);
  // 防止极端情况无限增长
  if (session.navStack.length > 50) {
    session.navStack.shift();
  }
  session.step = nextStep;
}

function backStep(session) {
  if (!session) return null;
  ensureNavStack(session);

  if (session.navStack.length === 0) return null;
  const prev = session.navStack.pop();
  if (!prev) return null;
  session.step = prev;
  return prev;
}

function buildStepMessage(session) {
  const id = session.sessionId;

  const backBtn = new ButtonBuilder()
    .setCustomId(`sr_wiz:${id}:back`)
    .setLabel('⬅️ 上一步')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!session.navStack || session.navStack.length === 0);

  if (session.step === 'base') {
    const embed = buildWizardEmbed(
      session,
      '基础信息',
      1,
      9,
      [
        '请设置该岗位在面板/列表中的显示名称与描述（可选）。',
        '不修改也可以直接进入下一步。',
      ],
      [
        { name: '显示名称', value: session.data.label ? session.data.label : '（空）', inline: false },
        { name: '描述', value: session.data.description ? session.data.description : '（无）', inline: false },
      ],
    );

    const row = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:base_edit`)
        .setLabel('编辑显示名称/描述')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:base_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
  }

  if (session.step === 'approval_mode') {
    const embed = buildWizardEmbed(
      session,
      '是否需要审核',
      2,
      9,
      ['请选择该岗位的发放方式：直授（无需审核）或社区审核（投票通过后发放）。'],
      [
        {
          name: '当前选择',
          value: session.data.approvalRequired ? '需要审核（投票）' : '直授（无需审核）',
          inline: false,
        },
      ],
    );

    const row = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:approval_direct`)
        .setLabel('✅ 直授（无需审核）')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:approval_review`)
        .setLabel('🗳️ 需要审核')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
  }

  if (session.step === 'approval_config') {
    ensureApprovalObject(session);

    const ap = session.data.approval;
    const votersText = formatRoleMentions(ap.allowedVoterRoles);

    const embed = buildWizardEmbed(
      session,
      '审核配置',
      3,
      9,
      [
        '请配置：审核频道、票数阈值、审核员身份组。',
        '注意：审核员身份组 **必须至少 1 个**，否则没人有权限投票。',
      ],
      [
        { name: '审核频道', value: formatChannelMention(ap.channelId), inline: false },
        {
          name: '票数阈值',
          value:
            ap.requiredApprovals && ap.requiredRejections
              ? `需 **${ap.requiredApprovals}** 支持 / **${ap.requiredRejections}** 反对`
              : '（未配置）',
          inline: false,
        },
        { name: '审核员身份组', value: votersText, inline: false },
        {
          name: '被拒后冷却',
          value: ap.cooldownDays && ap.cooldownDays > 0 ? `${ap.cooldownDays} 天` : '（未配置/不启用）',
          inline: false,
        },
      ],
    );

    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:approval_channel_select`)
      .setPlaceholder('选择审核频道')
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildForum,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      );

    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:approval_voter_roles_select`)
      .setPlaceholder('选择审核员身份组（可多选，建议<=5）')
      .setMinValues(1)
      .setMaxValues(5);

    const row1 = new ActionRowBuilder().addComponents(channelMenu);
    const row2 = new ActionRowBuilder().addComponents(roleMenu);

    const row3 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:approval_set_votes`)
        .setLabel('设置票数/冷却')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:approval_channel_link`)
        .setLabel('链接设置审核频道')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:approval_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2, row3] };
  }

  if (session.step === 'capacity') {
    const max = session.data.maxMembers;
    const embed = buildWizardEmbed(
      session,
      '人数上限',
      4,
      9,
      [
        '请设置该岗位的同时持有人数上限。',
        '（注意：系统的“名额/满员”口径只统计 bot 发放过并写入 grant 的成员；手动授予不占名额。）',
      ],
      [
        {
          name: '人数上限',
          value: typeof max === 'number' && max > 0 ? String(max) : '∞（不限制）',
          inline: false,
        },
      ],
    );

    const row = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:capacity_unlimited`)
        .setLabel('∞ 不限制')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:capacity_set`)
        .setLabel('设置上限')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
  }

  if (session.step === 'prerequisite') {
    const embed = buildWizardEmbed(
      session,
      '前置身份组',
      5,
      9,
      ['可选：设置前置身份组（用户必须先拥有该身份组，才能申请本岗位）。'],
      [
        {
          name: '前置身份组',
          value: session.data.prerequisiteRoleId ? `<@&${session.data.prerequisiteRoleId}>` : '（无）',
          inline: false,
        },
      ],
    );

    const menu = new RoleSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:prereq_role_select`)
      .setPlaceholder('选择前置身份组（可选）')
      .setMinValues(1)
      .setMaxValues(1);

    const row1 = new ActionRowBuilder().addComponents(menu);

    const row2 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:prereq_none`)
        .setLabel('不需要前置')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:prereq_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  if (session.step === 'activity_choice') {
    const a = session.data.activity;

    const activitySummary = !a
      ? '（未配置）'
      : `频道 ${formatChannelMention(a.channelId)}\n发言≥${a.requiredMessages || 0} 被提及≥${a.requiredMentions || 0} 主动提及≥${a.requiredMentioning || 0}` +
        (a.activeDaysThreshold
          ? `\n活跃天数：每日发言≥${a.activeDaysThreshold.dailyMessageThreshold}，需达到 ${a.activeDaysThreshold.requiredActiveDays} 天`
          : '');

    const embed = buildWizardEmbed(
      session,
      '活跃度门槛',
      6,
      9,
      ['可选：设置活跃度门槛（在指定频道的发言/被提及/主动提及/活跃天数）。'],
      [{ name: '当前活跃度配置', value: activitySummary, inline: false }],
    );

    const row = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_disable`)
        .setLabel('不需要活跃度')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_configure`)
        .setLabel('配置/修改')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
  }

  if (session.step === 'activity_config') {
    const a = session.data.activity || {
      channelId: null,
      requiredMessages: 0,
      requiredMentions: 0,
      requiredMentioning: 0,
      activeDaysThreshold: null,
    };

    const embed = buildWizardEmbed(
      session,
      '配置活跃度',
      6,
      9,
      [
        '请选择统计频道，然后设置阈值。',
        '提示：阈值可为 0；如需“活跃天数”条件，则必须同时提供「每日发言阈值」与「活跃天数」。',
      ],
      [
        { name: '统计频道', value: formatChannelMention(a.channelId), inline: false },
        {
          name: '阈值',
          value:
            `发言≥${a.requiredMessages || 0}，被提及≥${a.requiredMentions || 0}，主动提及≥${a.requiredMentioning || 0}` +
            (a.activeDaysThreshold
              ? `\n活跃天数：每日发言≥${a.activeDaysThreshold.dailyMessageThreshold}，需达到 ${a.activeDaysThreshold.requiredActiveDays} 天`
              : ''),
          inline: false,
        },
      ],
    );

    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:activity_channel_select`)
      .setPlaceholder('选择统计频道（文字频道）')
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(ChannelType.GuildText);

    const row1 = new ActionRowBuilder().addComponents(channelMenu);

    const row2 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_set_thresholds`)
        .setLabel('设置阈值')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_done`)
        .setLabel('完成并继续')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:activity_disable`)
        .setLabel('不配置活跃度')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  if (session.step === 'bundle') {
    const list = Array.isArray(session.data.bundleRoleIds) ? session.data.bundleRoleIds : [];
    const bundleText = formatRoleMentions(list);

    const embed = buildWizardEmbed(
      session,
      '配套身份组',
      7,
      9,
      ['可选：设置配套身份组（审核通过/直授时会一并授予）。'],
      [{ name: '配套身份组', value: bundleText, inline: false }],
    );

    const menu = new RoleSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:bundle_roles_select`)
      .setPlaceholder('选择配套身份组（可多选）')
      .setMinValues(1)
      .setMaxValues(5);

    const row1 = new ActionRowBuilder().addComponents(menu);

    const row2 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:bundle_clear`)
        .setLabel('清空配套身份组')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:bundle_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  if (session.step === 'lifecycle') {
    const lc = session.data.lifecycle || {};
    const embed = buildWizardEmbed(
      session,
      '周期清退',
      8,
      9,
      [
        '可选：启用周期询问/强制清退（仅对 bot 发放并写入 grant 的成员生效）。',
        '说明：若开启“满员才执行”，但未配置人数上限，则系统无法可靠判断满员。',
      ],
      [
        { name: '启用状态', value: lc.enabled ? '✅ 启用' : '❌ 未启用', inline: true },
        {
          name: '询问周期',
          value: typeof lc.inquiryDays === 'number' ? (lc.inquiryDays > 0 ? `${lc.inquiryDays} 天` : '不询问') : '（未设置）',
          inline: true,
        },
        {
          name: '强制清退',
          value: typeof lc.forceRemoveDays === 'number' ? (lc.forceRemoveDays > 0 ? `${lc.forceRemoveDays} 天` : '不强制') : '（未设置）',
          inline: true,
        },
        { name: '满员才执行', value: lc.onlyWhenFull ? '是' : '否', inline: true },
        { name: '报告频道', value: formatChannelMention(lc.reportChannelId), inline: true },
      ],
    );

    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:lifecycle_report_channel_select`)
      .setPlaceholder('选择报告频道（可选）')
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_enable`)
        .setLabel('启用')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_disable`)
        .setLabel('关闭')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_toggle_onlyWhenFull`)
        .setLabel('切换满员才执行')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_set_days`)
        .setLabel('设置天数')
        .setStyle(ButtonStyle.Primary),
    );

    const row2 = new ActionRowBuilder().addComponents(channelMenu);

    const row3 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_next`)
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:lifecycle_report_channel_link`)
        .setLabel('链接设置报告频道')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sr_wiz:${id}:cancel`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2, row3] };
  }

  if (session.step === 'reason') {
    const r = session.data.reason || { mode: 'disabled' };
    const modeText = r.mode === 'required' ? '必填' : r.mode === 'optional' ? '可选' : '禁用';
    const lenText = r.mode === 'disabled'
      ? '（不需要）'
      : `${typeof r.minLen === 'number' ? r.minLen : '默认10'}–${typeof r.maxLen === 'number' ? r.maxLen : '默认500'}`;

    const embed = buildWizardEmbed(
      session,
      '申请理由',
      9,
      9,
      ['设置申请理由：禁用 / 可选 / 必填，以及长度范围（可选）。'],
      [
        { name: '模式', value: modeText, inline: true },
        { name: '长度', value: lenText, inline: true },
      ],
    );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:reason_disabled`).setLabel('禁用').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:reason_optional`).setLabel('可选').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:reason_required`).setLabel('必填').setStyle(ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
      backBtn,
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:reason_set_len`).setLabel('设置长度').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:reason_next`).setLabel('预览并确认').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sr_wiz:${id}:cancel`).setLabel('取消').setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  if (session.step === 'summary') {
    const validation = validateSession(session);

    const parts = [];

    parts.push(`**显示名称**：${session.data.label || '（空）'}`);
    if (session.data.description) {
      parts.push(`**描述**：${session.data.description}`);
    }

    parts.push(`**发放方式**：${session.data.approvalRequired ? '审核（投票）' : '直授'}`);

    if (session.data.approvalRequired) {
      ensureApprovalObject(session);
      const ap = session.data.approval;
      parts.push(`**审核频道**：${formatChannelMention(ap.channelId)}`);
      parts.push(
        `**票数阈值**：${
          ap.requiredApprovals && ap.requiredRejections
            ? `${ap.requiredApprovals} 支持 / ${ap.requiredRejections} 反对`
            : '（未配置）'
        }`,
      );
      parts.push(`**审核员身份组**：${formatRoleMentions(ap.allowedVoterRoles)}`);
      if (ap.cooldownDays && ap.cooldownDays > 0) {
        parts.push(`**被拒后冷却**：${ap.cooldownDays} 天`);
      }
    }

    const max = session.data.maxMembers;
    parts.push(`**人数上限**：${typeof max === 'number' && max > 0 ? max : '∞（不限制）'}`);

    parts.push(
      `**前置身份组**：${session.data.prerequisiteRoleId ? `<@&${session.data.prerequisiteRoleId}>` : '（无）'}`,
    );

    if (session.data.activity) {
      const a = session.data.activity;
      parts.push(`**活跃度频道**：${formatChannelMention(a.channelId)}`);
      parts.push(
        `**活跃度阈值**：发言≥${a.requiredMessages || 0} 被提及≥${a.requiredMentions || 0} 主动提及≥${a.requiredMentioning || 0}` +
          (a.activeDaysThreshold
            ? `；活跃天数：每日发言≥${a.activeDaysThreshold.dailyMessageThreshold}，需达到 ${a.activeDaysThreshold.requiredActiveDays} 天`
            : ''),
      );
    } else {
      parts.push('**活跃度**：未配置');
    }

    parts.push(`**配套身份组**：${formatRoleMentions(session.data.bundleRoleIds)}`);

    const lc = session.data.lifecycle || {};
    parts.push(`**周期清退**：${lc.enabled ? '启用' : '未启用'}`);
    if (lc.enabled) {
      parts.push(
        `**周期参数**：询问=${typeof lc.inquiryDays === 'number' ? lc.inquiryDays : '未设置'} 天；强制清退=${
          typeof lc.forceRemoveDays === 'number' ? lc.forceRemoveDays : '未设置'
        } 天；满员才执行=${lc.onlyWhenFull ? '是' : '否'}`, 
      );
      parts.push(`**报告频道**：${formatChannelMention(lc.reportChannelId)}`);
    }

    const r = session.data.reason || { mode: 'disabled' };
    const modeText = r.mode === 'required' ? '必填' : r.mode === 'optional' ? '可选' : '禁用';
    parts.push(`**申请理由**：${modeText}`);

    if (r.mode !== 'disabled') {
      parts.push(
        `**理由长度**：${typeof r.minLen === 'number' ? r.minLen : '默认10'}–${typeof r.maxLen === 'number' ? r.maxLen : '默认500'}`,
      );
    }

    const lines = [
      '下面是本次将写入的配置预览：',
      '如需修改，可点击 **⬅️ 上一步**，或使用下方的“返回到指定步骤”列表直接跳转。',
      '',
      ...parts.map((p) => `- ${p}`),
    ];

    if (validation.warnings.length > 0) {
      lines.push('', '⚠️ **警告**：');
      for (const w of validation.warnings) {
        lines.push(`- ${w}`);
      }
    }

    if (validation.errors.length > 0) {
      lines.push('', '❌ **错误（需修复后才能写入）**：');
      for (const e of validation.errors) {
        lines.push(`- ${e}`);
      }
    }

    const embed = buildWizardEmbed(session, '配置汇总预览', 10, 10, lines);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`sr_wiz:${id}:confirm`)
      .setLabel('✅ 确认写入')
      .setStyle(ButtonStyle.Success)
      .setDisabled(validation.errors.length > 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`sr_wiz:${id}:cancel`)
      .setLabel('❌ 取消')
      .setStyle(ButtonStyle.Danger);

    const row1 = new ActionRowBuilder().addComponents(backBtn, confirmBtn, cancelBtn);

    const jumpOptions = [
      { label: '基础信息', value: 'base', description: '显示名称 / 描述' },
      { label: '审核模式', value: 'approval_mode', description: '直授 / 审核' },
    ];

    if (session.data.approvalRequired) {
      jumpOptions.push({ label: '审核配置', value: 'approval_config', description: '频道 / 票数 / 审核员' });
    }

    jumpOptions.push(
      { label: '人数上限', value: 'capacity', description: '名额上限' },
      { label: '前置身份组', value: 'prerequisite', description: '可选' },
      { label: '活跃度门槛', value: 'activity_choice', description: '可选' },
      { label: '配套身份组', value: 'bundle', description: '可选' },
      { label: '周期清退', value: 'lifecycle', description: '可选' },
      { label: '申请理由', value: 'reason', description: '禁用/可选/必填' },
    );

    const jumpMenu = new StringSelectMenuBuilder()
      .setCustomId(`sr_wiz:${id}:summary_jump_step_select`)
      .setPlaceholder('返回到指定步骤进行修改…')
      .addOptions(jumpOptions);

    const row2 = new ActionRowBuilder().addComponents(jumpMenu);

    return { embeds: [embed], components: [row1, row2] };
  }

  // fallback
  const embed = new EmbedBuilder()
    .setTitle('❌ 配置向导状态异常')
    .setDescription('该向导可能已过期或状态损坏，请重新运行 /自助身份组申请-配置向导。')
    .setColor(0xed4245);
  return { embeds: [embed], components: [] };
}

function validateSession(session) {
  const errors = [];
  const warnings = [];

  if (!session.data.label || !String(session.data.label).trim()) {
    errors.push('显示名称不能为空。');
  }

  if (session.data.approvalRequired) {
    ensureApprovalObject(session);
    const ap = session.data.approval;
    if (!ap.channelId) errors.push('需要审核时必须选择审核频道。');
    if (!(ap.requiredApprovals > 0) || !(ap.requiredRejections > 0)) {
      errors.push('需要审核时必须设置支持票/反对票阈值（正整数）。');
    }
    if (!Array.isArray(ap.allowedVoterRoles) || ap.allowedVoterRoles.length === 0) {
      errors.push('需要审核时必须至少选择 1 个审核员身份组，否则没人能投票。');
    }
  }

  if (session.data.maxMembers != null) {
    const n = Number(session.data.maxMembers);
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push('人数上限将被视为“不限制”。');
    }
  }

  if (session.data.activity) {
    const a = session.data.activity;
    if (!a.channelId) {
      errors.push('已选择配置活跃度，但尚未选择统计频道。');
    }
    const dt = a.activeDaysThreshold;
    if (dt) {
      const d1 = Number(dt.dailyMessageThreshold);
      const d2 = Number(dt.requiredActiveDays);
      if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) {
        errors.push('活跃天数条件格式不正确：每日发言阈值/活跃天数必须为正整数。');
      }
    }
  }

  const lc = session.data.lifecycle || {};
  if (lc.onlyWhenFull && !(session.data.maxMembers > 0)) {
    warnings.push('已开启“满员才执行”，但未配置人数上限；系统将无法可靠判断满员。');
  }

  // reason
  const r = session.data.reason || { mode: 'disabled' };
  if (r.mode !== 'disabled') {
    if (r.minLen != null && (!(Number(r.minLen) > 0) || !Number.isFinite(Number(r.minLen)))) {
      errors.push('申请理由最小长度必须为正整数（或留空使用默认）。');
    }
    if (r.maxLen != null && (!(Number(r.maxLen) > 0) || !Number.isFinite(Number(r.maxLen)))) {
      errors.push('申请理由最大长度必须为正整数（或留空使用默认）。');
    }
    if (r.minLen != null && r.maxLen != null && Number(r.minLen) > Number(r.maxLen)) {
      errors.push('申请理由最小长度不得大于最大长度。');
    }
  }

  return { errors, warnings };
}

function buildBaseModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:base_modal`)
    .setTitle('配置基础信息');

  const labelInput = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('显示名称（必填）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(session.data.label || '').slice(0, 100));

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('描述（可选）')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(String(session.data.description || '').slice(0, 1000));

  modal.addComponents(
    new ActionRowBuilder().addComponents(labelInput),
    new ActionRowBuilder().addComponents(descInput),
  );

  return modal;
}

function buildApprovalVotesModal(session) {
  ensureApprovalObject(session);
  const ap = session.data.approval;

  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:approval_votes_modal`)
    .setTitle('配置审核阈值');

  const approvalsInput = new TextInputBuilder()
    .setCustomId('requiredApprovals')
    .setLabel('支持票阈值（正整数）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(ap.requiredApprovals != null ? String(ap.requiredApprovals) : '10');

  const rejectionsInput = new TextInputBuilder()
    .setCustomId('requiredRejections')
    .setLabel('反对票阈值（正整数）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(ap.requiredRejections != null ? String(ap.requiredRejections) : '5');

  const cooldownInput = new TextInputBuilder()
    .setCustomId('cooldownDays')
    .setLabel('被拒后冷却天数（可选，留空=不启用）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(ap.cooldownDays != null ? String(ap.cooldownDays) : '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(approvalsInput),
    new ActionRowBuilder().addComponents(rejectionsInput),
    new ActionRowBuilder().addComponents(cooldownInput),
  );

  return modal;
}

function buildApprovalChannelLinkModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:approval_channel_link_modal`)
    .setTitle('设置审核频道（链接）');

  const input = new TextInputBuilder()
    .setCustomId('channelLink')
    .setLabel('粘贴频道/子区链接或ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(session.data?.approval?.channelId ? String(session.data.approval.channelId) : '');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildCapacityModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:capacity_modal`)
    .setTitle('设置人数上限');

  const maxMembersInput = new TextInputBuilder()
    .setCustomId('maxMembers')
    .setLabel('人数上限（正整数；0/留空=不限制）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(session.data.maxMembers != null ? String(session.data.maxMembers) : '');

  modal.addComponents(new ActionRowBuilder().addComponents(maxMembersInput));
  return modal;
}

function buildActivityThresholdsModal(session) {
  const a = session.data.activity || {};
  const dt = a.activeDaysThreshold || {};

  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:activity_thresholds_modal`)
    .setTitle('设置活跃度阈值');

  const requiredMessages = new TextInputBuilder()
    .setCustomId('requiredMessages')
    .setLabel('发言数阈值（留空/0=不要求）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(a.requiredMessages != null ? String(a.requiredMessages) : '0');

  const requiredMentions = new TextInputBuilder()
    .setCustomId('requiredMentions')
    .setLabel('被提及数阈值（留空/0=不要求）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(a.requiredMentions != null ? String(a.requiredMentions) : '0');

  const requiredMentioning = new TextInputBuilder()
    .setCustomId('requiredMentioning')
    .setLabel('主动提及数阈值（留空/0=不要求）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(a.requiredMentioning != null ? String(a.requiredMentioning) : '0');

  const dailyThreshold = new TextInputBuilder()
    .setCustomId('dailyMessageThreshold')
    .setLabel('每日发言阈值（可选；需与“活跃天数”同时填写）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(dt.dailyMessageThreshold != null ? String(dt.dailyMessageThreshold) : '');

  const activeDays = new TextInputBuilder()
    .setCustomId('requiredActiveDays')
    .setLabel('活跃天数（可选；需与“每日阈值”同时填写）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(dt.requiredActiveDays != null ? String(dt.requiredActiveDays) : '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(requiredMessages),
    new ActionRowBuilder().addComponents(requiredMentions),
    new ActionRowBuilder().addComponents(requiredMentioning),
    new ActionRowBuilder().addComponents(dailyThreshold),
    new ActionRowBuilder().addComponents(activeDays),
  );

  return modal;
}

function buildLifecycleDaysModal(session) {
  const lc = session.data.lifecycle || {};

  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:lifecycle_days_modal`)
    .setTitle('设置周期天数');

  const inquiryInput = new TextInputBuilder()
    .setCustomId('inquiryDays')
    .setLabel('询问周期天数（0=不询问）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(typeof lc.inquiryDays === 'number' ? String(lc.inquiryDays) : '30');

  const forceInput = new TextInputBuilder()
    .setCustomId('forceRemoveDays')
    .setLabel('强制清退天数（0=不强制）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(typeof lc.forceRemoveDays === 'number' ? String(lc.forceRemoveDays) : '60');

  modal.addComponents(
    new ActionRowBuilder().addComponents(inquiryInput),
    new ActionRowBuilder().addComponents(forceInput),
  );

  return modal;
}

function buildLifecycleReportChannelLinkModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:lifecycle_report_channel_link_modal`)
    .setTitle('设置报告频道（链接）');

  const input = new TextInputBuilder()
    .setCustomId('channelLink')
    .setLabel('粘贴频道/子区链接或ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(session.data?.lifecycle?.reportChannelId ? String(session.data.lifecycle.reportChannelId) : '');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildReasonLenModal(session) {
  const r = session.data.reason || { mode: 'disabled' };

  const modal = new ModalBuilder()
    .setCustomId(`sr_wiz:${session.sessionId}:reason_len_modal`)
    .setTitle('设置申请理由长度');

  const minInput = new TextInputBuilder()
    .setCustomId('minLen')
    .setLabel('最小长度（可选；留空=默认10）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(r.minLen != null ? String(r.minLen) : '');

  const maxInput = new TextInputBuilder()
    .setCustomId('maxLen')
    .setLabel('最大长度（可选；留空=默认500）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(r.maxLen != null ? String(r.maxLen) : '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(minInput),
    new ActionRowBuilder().addComponents(maxInput),
  );

  return modal;
}

function createSession({ sessionId, guildId, userId, roleId, roleName, existingRoleConfig }) {
  const baseLabel = existingRoleConfig?.label || roleName;
  const baseDesc = existingRoleConfig?.description || '';

  const approvalExisting = existingRoleConfig?.conditions?.approval;

  const data = {
    label: baseLabel,
    description: baseDesc,
    approvalRequired: !!approvalExisting,
    approval: approvalExisting
      ? {
          channelId: approvalExisting.channelId || null,
          requiredApprovals: approvalExisting.requiredApprovals || null,
          requiredRejections: approvalExisting.requiredRejections || null,
          allowedVoterRoles: Array.isArray(approvalExisting.allowedVoterRoles) ? [...approvalExisting.allowedVoterRoles] : [],
          cooldownDays: approvalExisting.cooldownDays ?? null,
          dmTemplates: approvalExisting.dmTemplates && typeof approvalExisting.dmTemplates === 'object' ? { ...approvalExisting.dmTemplates } : {},
        }
      : {
          channelId: null,
          requiredApprovals: null,
          requiredRejections: null,
          allowedVoterRoles: [],
          cooldownDays: null,
          dmTemplates: {},
        },

    maxMembers: existingRoleConfig?.conditions?.capacity?.maxMembers ?? null,
    prerequisiteRoleId: existingRoleConfig?.conditions?.prerequisiteRoleId || null,
    activity: existingRoleConfig?.conditions?.activity ? { ...existingRoleConfig.conditions.activity } : null,
    bundleRoleIds: Array.isArray(existingRoleConfig?.bundleRoleIds) ? [...new Set(existingRoleConfig.bundleRoleIds)] : [],
    lifecycle: existingRoleConfig?.lifecycle ? { ...existingRoleConfig.lifecycle } : { enabled: false, inquiryDays: 30, forceRemoveDays: 60, onlyWhenFull: false, reportChannelId: null },
    reason: existingRoleConfig?.conditions?.reason ? { ...existingRoleConfig.conditions.reason } : { mode: 'disabled' },
  };

  return {
    sessionId,
    guildId,
    userId,
    roleId,
    roleName,
    createdAt: Date.now(),
    expiresAt: Date.now() + WIZARD_SESSION_TTL_MS,
    navStack: [],
    step: 'base',
    data,
  };
}

async function startSelfRoleConfigWizard(interaction) {
  if (!interaction.guild) {
    await interaction.editReply({ content: '❌ 此命令只能在服务器中使用。' });
    return;
  }

  if (!checkAdminPermission(interaction.member)) {
    await interaction.editReply({ content: getPermissionDeniedMessage() });
    return;
  }

  cleanupExpiredSessions();

  const role = interaction.options.getRole('目标身份组', true);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  // 同一用户在同一服务器只允许一个 active session（避免交互串台）
  for (const [id, s] of wizardSessions.entries()) {
    if (s && s.guildId === guildId && s.userId === userId) {
      wizardSessions.delete(id);
    }
  }

  const settings = await getSelfRoleSettings(guildId).catch(() => null);
  const existing = settings?.roles?.find((r) => r && r.roleId === role.id) || null;

  const sessionId = randomUUID();
  const session = createSession({
    sessionId,
    guildId,
    userId,
    roleId: role.id,
    roleName: role.name,
    existingRoleConfig: existing,
  });

  wizardSessions.set(sessionId, session);

  await interaction.editReply(buildStepMessage(session));
}

async function replySessionError(interaction, message) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: message, ephemeral: true });
    } else {
      await interaction.followUp({ content: message, ephemeral: true });
    }
  } catch (_) {}
}

function requireSession(interaction) {
  cleanupExpiredSessions();

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return { ok: false, reason: 'bad_custom_id' };

  const session = wizardSessions.get(parsed.sessionId);
  if (!session) return { ok: false, reason: 'session_not_found', parsed };

  if (interaction.guild?.id && session.guildId && interaction.guild.id !== session.guildId) {
    return { ok: false, reason: 'guild_mismatch', parsed, session };
  }

  if (interaction.user?.id && session.userId && interaction.user.id !== session.userId) {
    return { ok: false, reason: 'user_mismatch', parsed, session };
  }

  return { ok: true, session, parsed };
}

async function handleWizardCancel(interaction, session) {
  wizardSessions.delete(session.sessionId);

  try {
    if (interaction.isButton()) {
      await interaction.update({ content: '✅ 已取消配置向导。', embeds: [], components: [] });
    } else {
      await interaction.reply({ content: '✅ 已取消配置向导。', ephemeral: true });
    }
  } catch (_) {
    await replySessionError(interaction, '✅ 已取消配置向导。');
  }
}

async function handleSelfRoleConfigWizardButton(interaction) {
  const req = requireSession(interaction);
  if (!req.ok) {
    await replySessionError(interaction, '❌ 配置向导会话不存在或已过期，请重新运行 /自助身份组申请-配置向导。');
    return;
  }

  const { session, parsed } = req;

  if (!checkAdminPermission(interaction.member)) {
    await replySessionError(interaction, getPermissionDeniedMessage());
    return;
  }

  const action = parsed.action;

  if (action === 'cancel') {
    await handleWizardCancel(interaction, session);
    return;
  }

  if (action === 'back') {
    const prev = backStep(session);
    if (!prev) {
      await replySessionError(interaction, '❌ 无法返回上一步：可能已是第一步或会话状态异常。');
      return;
    }
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- base ---
  if (action === 'base_next') {
    gotoStep(session, 'approval_mode');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'base_edit') {
    const modal = buildBaseModal(session);
    await interaction.showModal(modal);
    return;
  }

  // --- approval mode ---
  if (action === 'approval_direct') {
    session.data.approvalRequired = false;
    gotoStep(session, 'capacity');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'approval_review') {
    session.data.approvalRequired = true;
    ensureApprovalObject(session);
    gotoStep(session, 'approval_config');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- approval config ---
  if (action === 'approval_set_votes') {
    const modal = buildApprovalVotesModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'approval_channel_link') {
    const modal = buildApprovalChannelLinkModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'approval_next') {
    const v = validateSession(session);
    if (v.errors.length > 0) {
      await replySessionError(interaction, `❌ 当前配置存在问题，无法继续：\n- ${v.errors.join('\n- ')}`);
      return;
    }

    gotoStep(session, 'capacity');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- capacity ---
  if (action === 'capacity_unlimited') {
    session.data.maxMembers = null;
    gotoStep(session, 'prerequisite');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'capacity_set') {
    const modal = buildCapacityModal(session);
    await interaction.showModal(modal);
    return;
  }

  // --- prerequisite ---
  if (action === 'prereq_none') {
    session.data.prerequisiteRoleId = null;
    gotoStep(session, 'activity_choice');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'prereq_next') {
    gotoStep(session, 'activity_choice');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- activity ---
  if (action === 'activity_disable') {
    session.data.activity = null;
    gotoStep(session, 'bundle');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'activity_configure') {
    if (!session.data.activity) {
      session.data.activity = {
        channelId: null,
        requiredMessages: 0,
        requiredMentions: 0,
        requiredMentioning: 0,
      };
    }
    gotoStep(session, 'activity_config');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'activity_set_thresholds') {
    const modal = buildActivityThresholdsModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'activity_done') {
    const v = validateSession(session);
    if (v.errors.some((e) => e.includes('统计频道'))) {
      await replySessionError(interaction, '❌ 请先选择统计频道。');
      return;
    }
    gotoStep(session, 'bundle');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'activity_next') {
    gotoStep(session, 'bundle');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- bundle ---
  if (action === 'bundle_clear') {
    session.data.bundleRoleIds = [];
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'bundle_next') {
    gotoStep(session, 'lifecycle');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- lifecycle ---
  if (action === 'lifecycle_enable') {
    if (!session.data.lifecycle) session.data.lifecycle = {};
    session.data.lifecycle.enabled = true;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_disable') {
    if (!session.data.lifecycle) session.data.lifecycle = {};
    session.data.lifecycle.enabled = false;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_toggle_onlyWhenFull') {
    if (!session.data.lifecycle) session.data.lifecycle = {};
    session.data.lifecycle.onlyWhenFull = !session.data.lifecycle.onlyWhenFull;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_set_days') {
    const modal = buildLifecycleDaysModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'lifecycle_report_channel_link') {
    const modal = buildLifecycleReportChannelLinkModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'lifecycle_next') {
    gotoStep(session, 'reason');
    await interaction.update(buildStepMessage(session));
    return;
  }

  // --- reason ---
  if (action === 'reason_disabled') {
    session.data.reason = { mode: 'disabled' };
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'reason_optional') {
    session.data.reason = session.data.reason && typeof session.data.reason === 'object' ? session.data.reason : {};
    session.data.reason.mode = 'optional';
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'reason_required') {
    session.data.reason = session.data.reason && typeof session.data.reason === 'object' ? session.data.reason : {};
    session.data.reason.mode = 'required';
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'reason_set_len') {
    const modal = buildReasonLenModal(session);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'reason_next') {
    gotoStep(session, 'summary');
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'confirm') {
    await interaction.deferUpdate();

    const validation = validateSession(session);
    if (validation.errors.length > 0) {
      await interaction.followUp({
        content: `❌ 当前配置存在错误，无法写入：\n- ${validation.errors.join('\n- ')}`,
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    const guildId = session.guildId;

    let settings = await getSelfRoleSettings(guildId).catch(() => null);
    if (!settings) settings = { roles: [] };

    const idx = settings.roles.findIndex((r) => r && r.roleId === session.roleId);
    const prev = idx >= 0 ? settings.roles[idx] : null;

    const next = {
      roleId: session.roleId,
      label: String(session.data.label || session.roleName).trim(),
      description: String(session.data.description || ''),
      conditions: { ...(prev?.conditions || {}) },
      bundleRoleIds: Array.isArray(session.data.bundleRoleIds) ? [...new Set(session.data.bundleRoleIds.filter(Boolean))] : [],
      lifecycle: { ...(prev?.lifecycle || {}), ...(session.data.lifecycle || {}) },
    };

    // --- capacity ---
    if (session.data.maxMembers && Number(session.data.maxMembers) > 0) {
      next.conditions.capacity = { maxMembers: Math.floor(Number(session.data.maxMembers)) };
    } else {
      delete next.conditions.capacity;
    }

    // --- prerequisite ---
    if (session.data.prerequisiteRoleId) {
      next.conditions.prerequisiteRoleId = session.data.prerequisiteRoleId;
    } else {
      delete next.conditions.prerequisiteRoleId;
    }

    // --- activity ---
    if (session.data.activity && session.data.activity.channelId) {
      next.conditions.activity = { ...session.data.activity };
    } else {
      delete next.conditions.activity;
    }

    // --- approval ---
    if (session.data.approvalRequired) {
      ensureApprovalObject(session);
      const ap = session.data.approval;
      next.conditions.approval = {
        ...(prev?.conditions?.approval || {}),
        channelId: ap.channelId,
        requiredApprovals: Math.floor(Number(ap.requiredApprovals)),
        requiredRejections: Math.floor(Number(ap.requiredRejections)),
        allowedVoterRoles: Array.isArray(ap.allowedVoterRoles) ? [...new Set(ap.allowedVoterRoles)] : [],
        dmTemplates: ap.dmTemplates && typeof ap.dmTemplates === 'object' ? { ...ap.dmTemplates } : {},
      };
      if (ap.cooldownDays && Number(ap.cooldownDays) > 0) {
        next.conditions.approval.cooldownDays = Math.floor(Number(ap.cooldownDays));
      } else {
        delete next.conditions.approval.cooldownDays;
      }
    } else {
      delete next.conditions.approval;
    }

    // --- reason ---
    const r = session.data.reason || { mode: 'disabled' };
    if (r.mode && r.mode !== 'disabled') {
      next.conditions.reason = { mode: r.mode };
      if (r.minLen != null && String(r.minLen).trim() !== '') {
        next.conditions.reason.minLen = Math.floor(Number(r.minLen));
      }
      if (r.maxLen != null && String(r.maxLen).trim() !== '') {
        next.conditions.reason.maxLen = Math.floor(Number(r.maxLen));
      }
    } else {
      delete next.conditions.reason;
    }

    // --- lifecycle cleanup: reportChannelId 空则删除 ---
    if (next.lifecycle && !next.lifecycle.reportChannelId) {
      delete next.lifecycle.reportChannelId;
    }

    // --- bundle: 排除自己 ---
    next.bundleRoleIds = next.bundleRoleIds.filter((rid) => rid && rid !== session.roleId);

    if (idx >= 0) {
      settings.roles[idx] = next;
    } else {
      settings.roles.push(next);
    }

    await saveSelfRoleSettings(guildId, settings);
    await updateMonitoredChannels(guildId).catch(() => {});
    scheduleActiveUserSelfRolePanelsRefresh(interaction.client, guildId, 'wizard_config_saved');

    wizardSessions.delete(session.sessionId);

    const okEmbed = new EmbedBuilder()
      .setTitle('✅ 配置向导已写入')
      .setColor(0x57F287)
      .setDescription(
        `已写入身份组 <@&${session.roleId}> 的配置。\n\n` +
          `你可以：\n` +
          `- 使用 /自助身份组申请-创建自助身份组面板 重召/刷新入口面板\n` +
          `- 或使用 /自助身份组申请-运维 刷新面板 立即刷新状态区`,
      );

    await interaction.editReply({ embeds: [okEmbed], components: [] });
    return;
  }

  await replySessionError(interaction, '❌ 未识别的向导操作（可能是旧消息或已过期步骤）。');
}

async function handleSelfRoleConfigWizardSelect(interaction) {
  const req = requireSession(interaction);
  if (!req.ok) {
    await replySessionError(interaction, '❌ 配置向导会话不存在或已过期，请重新运行 /自助身份组申请-配置向导。');
    return;
  }

  const { session, parsed } = req;

  if (!checkAdminPermission(interaction.member)) {
    await replySessionError(interaction, getPermissionDeniedMessage());
    return;
  }

  const action = parsed.action;

  if (action === 'approval_channel_select') {
    ensureApprovalObject(session);
    session.data.approval.channelId = interaction.values?.[0] || null;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'approval_voter_roles_select') {
    ensureApprovalObject(session);
    session.data.approval.allowedVoterRoles = Array.isArray(interaction.values) ? interaction.values : [];
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'prereq_role_select') {
    session.data.prerequisiteRoleId = interaction.values?.[0] || null;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'activity_channel_select') {
    if (!session.data.activity) session.data.activity = {};
    session.data.activity.channelId = interaction.values?.[0] || null;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'bundle_roles_select') {
    const picked = Array.isArray(interaction.values) ? interaction.values : [];
    session.data.bundleRoleIds = [...new Set(picked.filter((rid) => rid && rid !== session.roleId))];
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_report_channel_select') {
    if (!session.data.lifecycle) session.data.lifecycle = {};
    session.data.lifecycle.reportChannelId = interaction.values?.[0] || null;
    await interaction.update(buildStepMessage(session));
    return;
  }

  if (action === 'summary_jump_step_select') {
    const target = interaction.values?.[0] || null;
    const allowed = new Set([
      'base',
      'approval_mode',
      'approval_config',
      'capacity',
      'prerequisite',
      'activity_choice',
      'bundle',
      'lifecycle',
      'reason',
    ]);

    if (!target || !allowed.has(target)) {
      await replySessionError(interaction, '❌ 目标步骤无效或不受支持。');
      return;
    }

    if (target === 'approval_config' && !session.data.approvalRequired) {
      await replySessionError(interaction, '❌ 当前为“直授”模式，请先返回到“审核模式”并选择“需要审核”。');
      return;
    }

    gotoStep(session, target);
    await interaction.update(buildStepMessage(session));
    return;
  }

  await replySessionError(interaction, '❌ 未识别的向导选择菜单操作。');
}

async function handleSelfRoleConfigWizardModal(interaction) {
  const req = requireSession(interaction);
  if (!req.ok) {
    await interaction.reply({
      content: '❌ 配置向导会话不存在或已过期，请重新运行 /自助身份组申请-配置向导。',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const { session, parsed } = req;

  if (!checkAdminPermission(interaction.member)) {
    await interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const action = parsed.action;

  if (action === 'base_modal') {
    const label = String(interaction.fields.getTextInputValue('label') || '').trim();
    const description = String(interaction.fields.getTextInputValue('description') || '').trim();

    if (!label) {
      await interaction.editReply({ content: '❌ 显示名称不能为空。' });
      return;
    }

    session.data.label = label;
    session.data.description = description;

    gotoStep(session, 'approval_mode');
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'approval_votes_modal') {
    ensureApprovalObject(session);

    const approvals = Number(String(interaction.fields.getTextInputValue('requiredApprovals') || '').trim());
    const rejections = Number(String(interaction.fields.getTextInputValue('requiredRejections') || '').trim());
    const cooldownRaw = String(interaction.fields.getTextInputValue('cooldownDays') || '').trim();

    if (!Number.isFinite(approvals) || approvals <= 0 || !Number.isInteger(approvals)) {
      await interaction.editReply({ content: '❌ 支持票阈值必须为正整数。' });
      return;
    }
    if (!Number.isFinite(rejections) || rejections <= 0 || !Number.isInteger(rejections)) {
      await interaction.editReply({ content: '❌ 反对票阈值必须为正整数。' });
      return;
    }

    let cooldownDays = null;
    if (cooldownRaw) {
      const n = Number(cooldownRaw);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        await interaction.editReply({ content: '❌ 冷却天数必须为正整数或留空。' });
        return;
      }
      cooldownDays = n;
    }

    session.data.approval.requiredApprovals = approvals;
    session.data.approval.requiredRejections = rejections;
    session.data.approval.cooldownDays = cooldownDays;

    session.step = 'approval_config';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'approval_channel_link_modal') {
    ensureApprovalObject(session);

    const raw = String(interaction.fields.getTextInputValue('channelLink') || '').trim();
    const cid = extractChannelIdFromText(raw);
    if (!cid) {
      await interaction.editReply({ content: '❌ 无法解析该链接/ID，请粘贴频道/子区链接或ID。' });
      return;
    }

    const ch = await interaction.guild.channels.fetch(cid).catch(() => null);
    if (!ch) {
      await interaction.editReply({ content: '❌ 找不到该频道/子区，请确认链接或ID正确，并且属于本服务器。' });
      return;
    }

    if (ch.guildId && ch.guildId !== session.guildId) {
      await interaction.editReply({ content: '❌ 该频道不属于当前服务器，请检查链接。' });
      return;
    }

    const allowed = new Set([
      ChannelType.GuildText,
      ChannelType.GuildForum,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ]);

    if (!allowed.has(ch.type)) {
      await interaction.editReply({ content: '❌ 审核频道必须为文字频道/论坛/子区（线程）。' });
      return;
    }

    session.data.approval.channelId = ch.id;
    session.step = 'approval_config';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'capacity_modal') {
    const raw = String(interaction.fields.getTextInputValue('maxMembers') || '').trim();

    if (!raw) {
      session.data.maxMembers = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        await interaction.editReply({ content: '❌ 人数上限必须为非负整数（0=不限制）。' });
        return;
      }
      session.data.maxMembers = n > 0 ? n : null;
    }

    gotoStep(session, 'prerequisite');
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'activity_thresholds_modal') {
    if (!session.data.activity) session.data.activity = {};

    const toInt = (v, fallback) => {
      const t = String(v ?? '').trim();
      if (!t) return fallback;
      const n = Number(t);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return NaN;
      return n;
    };

    const requiredMessages = toInt(interaction.fields.getTextInputValue('requiredMessages'), 0);
    const requiredMentions = toInt(interaction.fields.getTextInputValue('requiredMentions'), 0);
    const requiredMentioning = toInt(interaction.fields.getTextInputValue('requiredMentioning'), 0);
    const daily = toInt(interaction.fields.getTextInputValue('dailyMessageThreshold'), null);
    const days = toInt(interaction.fields.getTextInputValue('requiredActiveDays'), null);

    if ([requiredMessages, requiredMentions, requiredMentioning].some((n) => Number.isNaN(n) || n < 0)) {
      await interaction.editReply({ content: '❌ 发言/被提及/主动提及阈值必须为非负整数（留空视为0）。' });
      return;
    }

    if ((daily != null && days == null) || (daily == null && days != null)) {
      await interaction.editReply({ content: '❌ “每日发言阈值”和“活跃天数”需要同时填写或同时留空。' });
      return;
    }

    if (daily != null && days != null) {
      if (Number.isNaN(daily) || Number.isNaN(days) || daily <= 0 || days <= 0) {
        await interaction.editReply({ content: '❌ 活跃天数条件需要正整数：每日发言阈值、活跃天数。' });
        return;
      }
      session.data.activity.activeDaysThreshold = {
        dailyMessageThreshold: daily,
        requiredActiveDays: days,
      };
    } else {
      delete session.data.activity.activeDaysThreshold;
    }

    session.data.activity.requiredMessages = requiredMessages;
    session.data.activity.requiredMentions = requiredMentions;
    session.data.activity.requiredMentioning = requiredMentioning;

    session.step = 'activity_config';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_days_modal') {
    if (!session.data.lifecycle) session.data.lifecycle = {};

    const inquiryDays = Number(String(interaction.fields.getTextInputValue('inquiryDays') || '').trim());
    const forceRemoveDays = Number(String(interaction.fields.getTextInputValue('forceRemoveDays') || '').trim());

    if (!Number.isFinite(inquiryDays) || inquiryDays < 0 || !Number.isInteger(inquiryDays)) {
      await interaction.editReply({ content: '❌ 询问周期天数必须为非负整数。' });
      return;
    }

    if (!Number.isFinite(forceRemoveDays) || forceRemoveDays < 0 || !Number.isInteger(forceRemoveDays)) {
      await interaction.editReply({ content: '❌ 强制清退天数必须为非负整数。' });
      return;
    }

    session.data.lifecycle.inquiryDays = inquiryDays;
    session.data.lifecycle.forceRemoveDays = forceRemoveDays;

    session.step = 'lifecycle';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'lifecycle_report_channel_link_modal') {
    if (!session.data.lifecycle) session.data.lifecycle = {};

    const raw = String(interaction.fields.getTextInputValue('channelLink') || '').trim();
    const cid = extractChannelIdFromText(raw);
    if (!cid) {
      await interaction.editReply({ content: '❌ 无法解析该链接/ID，请粘贴频道/子区链接或ID。' });
      return;
    }

    const ch = await interaction.guild.channels.fetch(cid).catch(() => null);
    if (!ch) {
      await interaction.editReply({ content: '❌ 找不到该频道/子区，请确认链接或ID正确，并且属于本服务器。' });
      return;
    }

    if (ch.guildId && ch.guildId !== session.guildId) {
      await interaction.editReply({ content: '❌ 该频道不属于当前服务器，请检查链接。' });
      return;
    }

    // 报告频道必须可 send
    if (!ch.isTextBased?.() || ch.type === ChannelType.GuildForum) {
      await interaction.editReply({ content: '❌ 报告频道必须为文字频道或子区（线程）。不支持直接设置为论坛频道。' });
      return;
    }

    session.data.lifecycle.reportChannelId = ch.id;
    session.step = 'lifecycle';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  if (action === 'reason_len_modal') {
    if (!session.data.reason || typeof session.data.reason !== 'object') session.data.reason = { mode: 'disabled' };

    const minRaw = String(interaction.fields.getTextInputValue('minLen') || '').trim();
    const maxRaw = String(interaction.fields.getTextInputValue('maxLen') || '').trim();

    const parseOptInt = (raw) => {
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return NaN;
      return n;
    };

    const minLen = parseOptInt(minRaw);
    const maxLen = parseOptInt(maxRaw);

    if (Number.isNaN(minLen) || Number.isNaN(maxLen)) {
      await interaction.editReply({ content: '❌ 最小/最大长度必须为正整数或留空。' });
      return;
    }

    if (minLen != null && maxLen != null && minLen > maxLen) {
      await interaction.editReply({ content: '❌ 最小长度不得大于最大长度。' });
      return;
    }

    if (minLen == null) {
      delete session.data.reason.minLen;
    } else {
      session.data.reason.minLen = minLen;
    }

    if (maxLen == null) {
      delete session.data.reason.maxLen;
    } else {
      session.data.reason.maxLen = maxLen;
    }

    session.step = 'reason';
    await interaction.editReply(buildStepMessage(session));
    return;
  }

  await interaction.editReply({ content: '❌ 未识别的向导表单提交。' });
}

module.exports = {
  startSelfRoleConfigWizard,
  handleSelfRoleConfigWizardButton: handleSelfRoleConfigWizardButton,
  handleSelfRoleConfigWizardSelect: handleSelfRoleConfigWizardSelect,
  handleSelfRoleConfigWizardModal: handleSelfRoleConfigWizardModal,
};
