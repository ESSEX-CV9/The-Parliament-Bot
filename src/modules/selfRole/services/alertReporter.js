// src/modules/selfRole/services/alertReporter.js
//
// 目的：
// - 将 SelfRole 的异常“告警”简化为：仅发送一次显眼的错误报告（Embed + 一键确认按钮）
// - 使用 sr_system_alerts 仅做“去重/追踪”，不再依赖 Slash 指令查看/解决
//
// 说明：
// - 报告消息会附带按钮：✅ 标记为已处理
// - 点击后会将 sr_system_alerts.resolved_at 写入，并尽量禁用该条消息的按钮

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  createSelfRoleSystemAlert,
  getActiveSelfRoleSystemAlertByGrantType,
  getActiveSelfRoleSystemAlertByApplicationType,
  getSelfRoleSystemAlert,
  resolveSelfRoleSystemAlert,
  countActiveSelfRoleSystemAlertsByGrant,
  setSelfRoleGrantManualAttentionRequired,
} = require('../../../core/utils/database');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

function severityColor(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'high') return 0xed4245; // red
  if (s === 'medium') return 0xfee75c; // yellow
  if (s === 'low') return 0x57f287; // green
  return 0x5865f2; // blurple
}

function severityLabel(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return s || 'unknown';
}

function trimText(text, maxLen) {
  const raw = text == null ? '' : String(text);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function buildDisabledRows(message) {
  if (!message?.components || message.components.length === 0) return [];

  return message.components.map((row) => {
    const disabled = row.components.map((component) => {
      try {
        return ButtonBuilder.from(component).setDisabled(true);
      } catch (_) {
        return component;
      }
    });
    return new ActionRowBuilder().addComponents(disabled);
  });
}

function getMentionRoleIdFromEnv() {
  const rid = String(process.env.SELF_ROLE_ALERT_MENTION_ROLE_ID || '').trim();
  if (!rid) return null;
  if (!/^\d{17,20}$/.test(rid)) return null;
  return rid;
}

/**
 * 发送一次性“显眼错误报告”，并在 DB 中写入告警用于去重。
 *
 * 去重规则：
 * - 优先按 grantId + alertType 去重（如果 grantId 存在）
 * - 否则按 applicationId + alertType 去重（如果 applicationId 存在）
 * - 否则不去重（仍会写入 alert 记录，但可能重复）
 *
 * @param {object} params
 * @param {import('discord.js').Client} params.client
 * @param {string} params.guildId
 * @param {string} params.channelId - 报告发送目标频道
 * @param {string|null} params.roleId
 * @param {string|null} params.grantId
 * @param {string|null} params.applicationId
 * @param {string} params.alertType
 * @param {'high'|'medium'|'low'} params.severity
 * @param {string} params.message
 * @param {string|null} params.actionRequired
 * @param {string|null} params.title
 * @param {string|null} params.mentionRoleId - 可选：要 @ 的管理员身份组
 */
async function reportSelfRoleAlertOnce({
  client,
  guildId,
  channelId,
  roleId = null,
  grantId = null,
  applicationId = null,
  alertType,
  severity = 'medium',
  message,
  actionRequired = null,
  title = null,
  mentionRoleId = null,
}) {
  if (!client || !guildId || !alertType) {
    return { alert: null, reported: false, reason: 'bad_params' };
  }

  let existing = null;
  if (grantId) {
    existing = await getActiveSelfRoleSystemAlertByGrantType(grantId, alertType).catch(() => null);
  } else if (applicationId) {
    existing = await getActiveSelfRoleSystemAlertByApplicationType(applicationId, alertType).catch(() => null);
  }

  if (existing) {
    return { alert: existing, reported: false, reason: 'dedup_hit' };
  }

  const alert = await createSelfRoleSystemAlert({
    guildId,
    roleId,
    grantId,
    applicationId,
    alertType,
    severity,
    message,
    actionRequired,
  }).catch(() => null);

  if (!alert) {
    // DB 写入失败时仍尽量发一条报告（但无法做去重/按钮 resolve）
    const ch = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    if (ch && ch.isTextBased()) {
      await ch
        .send({
          content: `⚠️ SelfRole 异常（告警落库失败）：${trimText(message, 1500)}`,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }

    return { alert: null, reported: false, reason: 'db_failed' };
  }

  if (alert.deduped) {
    return { alert, reported: false, reason: 'dedup_hit' };
  }

  if (!channelId) {
    return { alert, reported: false, reason: 'no_channel' };
  }

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { alert, reported: false, reason: 'channel_missing' };
  }

  const embed = new EmbedBuilder()
    .setTitle(trimText(title || `🚨 SelfRole 异常需要处理`, 256))
    .setColor(severityColor(severity))
    .setDescription(
      trimText(
        `**问题**：${String(message || '').trim() || '（无）'}\n\n` +
          `**处理建议**：${String(actionRequired || '').trim() || '（无）'}\n\n` +
          `你可以点击下方按钮将该条报告标记为“已处理”。`,
        3900,
      ),
    )
    .addFields(
      { name: '告警ID', value: `\`${alert.alertId}\``, inline: true },
      { name: '类型', value: trimText(alertType, 100), inline: true },
      { name: '严重度', value: severityLabel(severity), inline: true },
      { name: '身份组', value: roleId ? `<@&${roleId}>` : '（未指定）', inline: false },
      { name: 'grant', value: grantId ? `\`${grantId}\`` : '（无）', inline: true },
      { name: 'application', value: applicationId ? `\`${applicationId}\`` : '（无）', inline: true },
    )
    .setTimestamp();

  const resolveBtn = new ButtonBuilder()
    .setCustomId(`sr_alert_resolve_${alert.alertId}`)
    .setLabel('✅ 标记为已处理')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(resolveBtn);

  const finalMentionRoleId = mentionRoleId || getMentionRoleIdFromEnv();
  const content = finalMentionRoleId ? `<@&${finalMentionRoleId}> SelfRole 出现异常需要处理` : null;

  const sent = await ch
    .send({
      content: content || undefined,
      embeds: [embed],
      components: [row],
      allowedMentions: finalMentionRoleId ? { roles: [finalMentionRoleId], users: [], parse: [] } : { parse: [] },
    })
    .catch((err) => {
      console.error(
        `[SelfRole][Alert] ❌ 发送错误报告失败: guild=${guildId} channel=${channelId} alertType=${alertType} alertId=${alert.alertId}`,
        err,
      );
      return null;
    });

  if (!sent) {
    return { alert, reported: false, reason: 'send_failed' };
  }

  return { alert, reported: true, reason: 'ok' };
}

function canManageAlerts(interaction) {
  // 允许：服务器拥有者 / Administrator / 指定管理身份组（permissionManager.ALLOWED_ROLE_IDS）
  return checkAdminPermission(interaction.member);
}

/**
 * 处理“标记为已处理”按钮
 * customId: sr_alert_resolve_<alertId>
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleSelfRoleAlertResolveButton(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!canManageAlerts(interaction)) {
    await interaction.editReply({ content: getPermissionDeniedMessage() });
    return;
  }

  const alertId = String(interaction.customId || '').replace('sr_alert_resolve_', '').trim();
  if (!alertId) {
    await interaction.editReply({ content: '❌ 无法解析告警ID。' });
    return;
  }

  const alert = await getSelfRoleSystemAlert(alertId).catch(() => null);
  if (!alert) {
    await interaction.editReply({ content: '❌ 找不到该告警记录（可能已被清理）。' });
    // 尽量禁用按钮，避免继续点击
    if (interaction.message) {
      await interaction.message.edit({ components: buildDisabledRows(interaction.message) }).catch(() => {});
    }
    return;
  }

  if (alert.guildId && interaction.guild && alert.guildId !== interaction.guild.id) {
    await interaction.editReply({ content: '❌ 该告警不属于当前服务器。' });
    return;
  }

  if (alert.resolvedAt) {
    await interaction.editReply({ content: 'ℹ️ 该告警已被处理。' });
    if (interaction.message) {
      await interaction.message.edit({ components: buildDisabledRows(interaction.message) }).catch(() => {});
    }
    return;
  }

  const ok = await resolveSelfRoleSystemAlert(alertId, Date.now()).catch(() => false);
  if (!ok) {
    await interaction.editReply({ content: '❌ 标记失败，请稍后重试。' });
    return;
  }

  // 若该告警关联 grant，则在“最后一条未解决告警被处理”时，清除 manual_attention_required
  if (alert.grantId) {
    const remain = await countActiveSelfRoleSystemAlertsByGrant(alert.grantId).catch(() => 0);
    if (remain === 0) {
      await setSelfRoleGrantManualAttentionRequired(alert.grantId, false).catch(() => {});
    }
  }

  // 禁用按钮（尽量）
  if (interaction.message) {
    await interaction.message.edit({ components: buildDisabledRows(interaction.message) }).catch(() => {});
  }

  await interaction.editReply({ content: '✅ 已标记为已处理。' });
}

module.exports = {
  reportSelfRoleAlertOnce,
  handleSelfRoleAlertResolveButton,
};
