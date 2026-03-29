// src/modules/selfRole/commands/configureRoles.js

const {
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');

const {
  getSelfRoleSettings,
  saveSelfRoleSettings,
} = require('../../../core/utils/database');

const {
  checkAdminPermission,
  getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');

const { updateMonitoredChannels } = require('../services/activityTracker');
const { scheduleActiveUserSelfRolePanelsRefresh } = require('../services/panelService');

/**
 * 统一的“自助身份组申请-配置身份组”斜杠命令
 * 子命令：
 * - 基础配置
 * - 审核配置
 * - 申请理由配置（模式可选，不填即禁用）
 * - 移除配置
 * - 展示已配置身份组
 *
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('自助身份组申请-配置身份组')
    .setDescription('配置自助身份组申请系统')

    // 子命令：基础配置
    .addSubcommand((sub) =>
      sub
        .setName('基础配置')
        .setDescription('新增/更新身份组的基础信息与活跃度条件')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要配置的身份组')
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName('统计频道')
            .setDescription('统计活跃度的目标频道（文字频道，可选）')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('显示名称')
            .setDescription('该身份组在配置面板/列表中的显示名称（留空则默认使用身份组名称）')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('描述')
            .setDescription('该身份组的简短描述（可选）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('发言数阈值')
            .setDescription('在统计频道内的发言数要求（默认0）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('被提及数阈值')
            .setDescription('在统计频道内被@次数要求（默认0）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('主动提及数阈值')
            .setDescription('在统计频道内主动@或回复次数要求（默认0）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('每日发言阈值')
            .setDescription('每日发言达标的阈值（需与「活跃天数」同时提供）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('活跃天数')
            .setDescription('近N天中每日发言达标的天数（需与「每日发言阈值」同时提供）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('人数上限')
            .setDescription('该身份组可同时拥有的最大人数（0=不限制，不填=保持不变）')
            .setMinValue(0)
            .setRequired(false),
        ),
    )

    // 子命令：审核配置
    .addSubcommand((sub) =>
      sub
        .setName('审核配置')
        .setDescription('设置该身份组的社区审核参数、审核员列表和私信模板')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要配置的身份组')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('支持票阈值')
            .setDescription('通过所需的支持票数')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('反对票阈值')
            .setDescription('拒绝所需的反对票数')
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName('审核频道')
            .setDescription('进行投票审核的频道（支持论坛和子区了）')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildForum,
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread
            )
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('审核频道链接')
            .setDescription('可粘贴频道/子区链接或ID（与“审核频道”二选一）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('审核员身份组1')
            .setDescription('可参与投票的审核员身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('审核员身份组2')
            .setDescription('可参与投票的审核员身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('审核员身份组3')
            .setDescription('可参与投票的审核员身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('审核员身份组4')
            .setDescription('可参与投票的审核员身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('审核员身份组5')
            .setDescription('可参与投票的审核员身份组（可选）')
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('清空审核员')
            .setDescription('是否清空已有审核员列表后再添加本次给定的')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('被拒后冷却天数')
            .setDescription('被拒绝后进入冷却期的天数（可选）')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('通过私信模板')
            .setDescription('申请通过后发送给申请人的私信模板，可用 {roleLabel} {roleName} {applicantMention}')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('拒绝私信模板')
            .setDescription('申请被拒后发送给申请人的私信模板，可用 {roleLabel} {roleName} {applicantMention} {cooldownDays} {cooldownNotice}')
            .setRequired(false),
        ),
    )

    // 子命令：配套身份组配置
    .addSubcommand((sub) =>
      sub
        .setName('配套身份组配置')
        .setDescription('设置该身份组在「审核通过/直授」时会一并授予的配套身份组')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要配置的主身份组')
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('配套身份组1')
            .setDescription('配套身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('配套身份组2')
            .setDescription('配套身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('配套身份组3')
            .setDescription('配套身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('配套身份组4')
            .setDescription('配套身份组（可选）')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('配套身份组5')
            .setDescription('配套身份组（可选）')
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('清空配套身份组')
            .setDescription('是否清空已有配套身份组列表后再添加本次给定的')
            .setRequired(false),
        ),
    )

    // 子命令：周期清退配置
    .addSubcommand((sub) =>
      sub
        .setName('周期清退配置')
        .setDescription('配置周期询问留任/退出、强制清退与 onlyWhenFull 行为')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要配置的身份组')
            .setRequired(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('启用')
            .setDescription('是否启用周期管理（不填则保持不变）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('询问周期天数')
            .setDescription('每隔 N 天询问一次留任/退出（0=不询问，不填=保持不变）')
            .setMinValue(0)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('强制清退天数')
            .setDescription('从授予起 N 天后强制退出（0=不强制，不填=保持不变）')
            .setMinValue(0)
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('满员才执行')
            .setDescription('onlyWhenFull：仅在身份组满员时才执行询问/清退（不填=保持不变）')
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('报告频道')
            .setDescription('发送周期询问/清退报告消息的频道（可选）')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            )
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('报告频道链接')
            .setDescription('可粘贴频道/子区链接或ID（可选；优先级低于“报告频道”）')
            .setRequired(false),
        ),
    )

    // 子命令：申请理由配置（模式可选）
    .addSubcommand((sub) =>
      sub
        .setName('申请理由配置')
        .setDescription('设置该身份组申请理由的模式与长度限制（模式可选，不填即视为禁用）')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要配置的身份组')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('模式')
            .setDescription('申请理由模式：必需|可选|禁用（不填即禁用）')
            .addChoices(
              { name: '必需', value: 'required' },
              { name: '可选', value: 'optional' },
              { name: '禁用', value: 'disabled' },
            )
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('最小长度')
            .setDescription('申请理由的最小长度（可选，>0）')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('最大长度')
            .setDescription('申请理由的最大长度（可选，>0）')
            .setRequired(false),
        ),
    )

    // 子命令：移除配置
    .addSubcommand((sub) =>
      sub
        .setName('移除配置')
        .setDescription('移除一个身份组的申请配置')
        .addRoleOption((opt) =>
          opt
            .setName('目标身份组')
            .setDescription('要移除的身份组')
            .setRequired(true),
        ),
    )

    // 子命令：展示已配置身份组
    .addSubcommand((sub) =>
      sub
        .setName('展示已配置身份组')
        .setDescription('展示当前所有已配置的可申请身份组摘要'),
    ),

  /**
   * 命令执行入口
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
      await interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    try {
      if (sub === '基础配置') {
        await handleBasicConfig(interaction);
      } else if (sub === '审核配置') {
        await handleApprovalConfig(interaction);
      } else if (sub === '配套身份组配置') {
        await handleBundleRolesConfig(interaction);
      } else if (sub === '周期清退配置') {
        await handleLifecycleConfig(interaction);
      } else if (sub === '申请理由配置') {
        await handleReasonConfig(interaction);
      } else if (sub === '移除配置') {
        await handleRemoveConfig(interaction);
      } else if (sub === '展示已配置身份组') {
        await handleListConfig(interaction);
      } else {
        await interaction.editReply({ content: '❌ 未识别的子命令。' });
      }
    } catch (err) {
      console.error('[SelfRole] ❌ 配置命令执行出错:', err);
      await interaction.editReply({ content: '❌ 执行配置命令时发生错误，请稍后重试。' });
    }
  },
};

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

/**
 * 处理“基础配置”
 */
async function handleBasicConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);
  let label = interaction.options.getString('显示名称') || role.name;
  const description = interaction.options.getString('描述') || '';
  const channel = interaction.options.getChannel('统计频道'); 
  const requiredMessages = interaction.options.getInteger('发言数阈值') ?? 0;
  const requiredMentions = interaction.options.getInteger('被提及数阈值') ?? 0;
  const requiredMentioning = interaction.options.getInteger('主动提及数阈值') ?? 0;
  const dailyThreshold = interaction.options.getInteger('每日发言阈值') ?? null;
  const activeDays = interaction.options.getInteger('活跃天数') ?? null;
  const maxMembersOpt = interaction.options.getInteger('人数上限');

  // 若未设置统计频道，但填写了任何活跃度阈值，提示错误
  const anyThresholdSet =
    (requiredMessages ?? 0) > 0 ||
    (requiredMentions ?? 0) > 0 ||
    (requiredMentioning ?? 0) > 0 ||
    dailyThreshold !== null ||
    activeDays !== null;

  if (!channel && anyThresholdSet) {
    await interaction.editReply({ content: '❌ 未设置“统计频道”时，不能配置活跃度阈值。请先选择统计频道，或清空所有阈值字段。' });
    return;
  }

  if (channel && channel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: `❌ 统计频道必须为文字频道。` });
    return;
  }

  // 活跃天数阈值配置校验（仅当提供了统计频道时才校验）
  if (channel) {
    if ((dailyThreshold && !activeDays) || (!dailyThreshold && activeDays)) {
      await interaction.editReply({ content: `❌ “每日发言阈值”和“活跃天数”需要同时提供且为正整数。` });
      return;
    }
    if (dailyThreshold && activeDays) {
      if (dailyThreshold <= 0 || activeDays <= 0) {
        await interaction.editReply({ content: `❌ “每日发言阈值”和“活跃天数”必须为正整数。` });
        return;
      }
    }
  }

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings) settings = { roles: [] };

  const roleId = role.id; // 保持为字符串
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);

  // 构造（可选）activity
  let activity = null;
  if (channel) {
    activity = {
      channelId: channel.id,
      requiredMessages: Math.max(0, requiredMessages),
      requiredMentions: Math.max(0, requiredMentions),
      requiredMentioning: Math.max(0, requiredMentioning),
    };
    if (dailyThreshold && activeDays) {
      activity.activeDaysThreshold = {
        dailyMessageThreshold: dailyThreshold,
        requiredActiveDays: activeDays,
      };
    }
  }

  if (idx >= 0) {
    // 合并更新：保留原有非基础字段
    const prev = settings.roles[idx];
    const newConditions = { ...prev.conditions };
    if (activity) {
      newConditions.activity = activity; // 仅当本次提供了统计频道时才覆盖
    }

    // 人数上限：不填则保持不变；填 0 表示取消上限
    if (maxMembersOpt !== null && maxMembersOpt !== undefined) {
      if (maxMembersOpt > 0) {
        newConditions.capacity = { maxMembers: maxMembersOpt };
      } else {
        delete newConditions.capacity;
      }
    }
    settings.roles[idx] = {
      roleId,
      label,
      description,
      conditions: newConditions,
    };
  } else {
    // 若未提供统计频道，则不写入 activity
    const base = {
      roleId,
      label,
      description,
      conditions: {},
    };
    if (activity) {
      base.conditions.activity = activity;
    }

    if (maxMembersOpt !== null && maxMembersOpt !== undefined && maxMembersOpt > 0) {
      base.conditions.capacity = { maxMembers: maxMembersOpt };
    }
    settings.roles.push(base);
  }

  await saveSelfRoleSettings(interaction.guild.id, settings);
  await updateMonitoredChannels(interaction.guild.id);
  scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'role_basic_config_updated');

  // 组装回执
  let desc = `**身份组：** <@&${roleId}>\n` + `**显示名称：** ${label}\n` + (description ? `**描述：** ${description}\n` : '');
  if (maxMembersOpt !== null && maxMembersOpt !== undefined) {
    desc += `**人数上限：** ${maxMembersOpt > 0 ? maxMembersOpt : '不限制'}\n`;
  } else {
    const prevCap = idx >= 0 ? settings.roles[idx]?.conditions?.capacity?.maxMembers : null;
    if (typeof prevCap === 'number' && prevCap > 0) {
      desc += `**人数上限：** ${prevCap}\n`;
    }
  }
  if (channel) {
    desc += `**统计频道：** <#${channel.id}>\n`;
    desc += `**发言数阈值：** ${Math.max(0, requiredMessages)}\n`;
    desc += `**被提及数阈值：** ${Math.max(0, requiredMentions)}\n`;
    desc += `**主动提及数阈值：** ${Math.max(0, requiredMentioning)}\n`;
    if (dailyThreshold && activeDays) {
      desc += `**活跃天数条件：** 每日发言≥${dailyThreshold} 条，需达到 ${activeDays} 天\n`;
    }
  } else {
    desc += `**活跃度：** 未配置（此身份组无需发言统计，可仅使用“审核配置”）\n`;
  }

  const embed = new EmbedBuilder().setTitle('✅ 基础配置成功').setColor(0x57F287).setDescription(desc);

  await interaction.editReply({ embeds: [embed] });
}

/**
 * 处理“审核配置”
 */
async function handleApprovalConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);
  const approvalChannelOpt = interaction.options.getChannel('审核频道');
  const approvalChannelLink = interaction.options.getString('审核频道链接');
  let approvalChannel = approvalChannelOpt;

  if (!approvalChannel) {
    const cid = extractChannelIdFromText(approvalChannelLink);
    if (!cid) {
      await interaction.editReply({ content: '❌ 请设置“审核频道”或填写“审核频道链接”。' });
      return;
    }
    approvalChannel = await interaction.guild.channels.fetch(cid).catch(() => null);
    if (!approvalChannel) {
      await interaction.editReply({ content: '❌ 无法通过“审核频道链接”找到频道/子区，请确认链接或ID正确。' });
      return;
    }
  }

  // 额外校验：避免跨服链接
  if (approvalChannel.guildId && approvalChannel.guildId !== interaction.guild.id) {
    await interaction.editReply({ content: '❌ 审核频道不属于当前服务器，请检查链接。' });
    return;
  }

  const requiredApprovals = interaction.options.getInteger('支持票阈值', true);
  const requiredRejections = interaction.options.getInteger('反对票阈值', true);
  const voter1 = interaction.options.getRole('审核员身份组1');
  const voter2 = interaction.options.getRole('审核员身份组2');
  const voter3 = interaction.options.getRole('审核员身份组3');
  const voter4 = interaction.options.getRole('审核员身份组4');
  const voter5 = interaction.options.getRole('审核员身份组5');
  const clearVoters = interaction.options.getBoolean('清空审核员') ?? false;
  const cooldownDays = interaction.options.getInteger('被拒后冷却天数') ?? null;
  const approvedDmTemplate = interaction.options.getString('通过私信模板');
  const rejectedDmTemplate = interaction.options.getString('拒绝私信模板');

  const allowedTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildForum,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ]);
  if (!approvalChannel || !allowedTypes.has(approvalChannel.type)) {
    await interaction.editReply({ content: `❌ 审核频道必须为文字频道、论坛频道或子区。` });
    return;
  }
  if (requiredApprovals <= 0 || requiredRejections <= 0) {
    await interaction.editReply({ content: `❌ 支持票/反对票阈值必须为正整数。` });
    return;
  }

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings) settings = { roles: [] };

  const roleId = role.id;
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);

  // 若基础配置不存在，则以角色名作为默认显示名称创建最小结构
  if (idx < 0) {
    settings.roles.push({
      roleId,
      label: role.name,
      description: '',
      conditions: {},
    });
  }

  const current = settings.roles.find((r) => r.roleId === roleId);
  if (!current.conditions) current.conditions = {};

  // 构造审核员列表
  const incomingVoters = [voter1, voter2, voter3, voter4, voter5]
    .filter(Boolean)
    .map((v) => v.id);

  let allowedVoterRoles = Array.isArray(current.conditions.approval?.allowedVoterRoles)
    ? [...current.conditions.approval.allowedVoterRoles]
    : [];

  if (clearVoters) {
    allowedVoterRoles = [];
  }
  for (const rid of incomingVoters) {
    if (!allowedVoterRoles.includes(rid)) {
      allowedVoterRoles.push(rid);
    }
  }

  const previousApproval = current.conditions.approval || {};
  const previousDmTemplates = previousApproval.dmTemplates || {};

  current.conditions.approval = {
    ...previousApproval,
    channelId: approvalChannel.id,
    requiredApprovals,
    requiredRejections,
    allowedVoterRoles,
    dmTemplates: {
      ...previousDmTemplates,
    },
  };

  if (cooldownDays && cooldownDays > 0) {
    current.conditions.approval.cooldownDays = cooldownDays;
  } else {
    // 若未提供则移除该字段
    delete current.conditions.approval.cooldownDays;
  }

  if (approvedDmTemplate !== null) {
    current.conditions.approval.dmTemplates.approved = approvedDmTemplate;
  }

  if (rejectedDmTemplate !== null) {
    current.conditions.approval.dmTemplates.rejected = rejectedDmTemplate;
  }

  // 回写
  const writeIdx = settings.roles.findIndex((r) => r.roleId === roleId);
  settings.roles[writeIdx] = current;

  await saveSelfRoleSettings(interaction.guild.id, settings);
  scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'role_approval_config_updated');

  const embed = new EmbedBuilder()
    .setTitle('✅ 审核配置成功')
    .setColor(0x57F287)
    .setDescription(
      `**身份组：** <@&${roleId}>\n` +
        `**审核频道：** <#${approvalChannel.id}>\n` +
        `**阈值：** 需 ${requiredApprovals} 支持 / ${requiredRejections} 反对\n` +
        `**审核员：** ${
          allowedVoterRoles.length > 0 ? allowedVoterRoles.map((rid) => `<@&${rid}>`).join('，') : '未配置'
        }\n` +
        (current.conditions.approval.cooldownDays
          ? `**被拒后冷却：** ${current.conditions.approval.cooldownDays} 天\n`
          : '') +
        `**通过私信：** ${current.conditions.approval.dmTemplates?.approved ? '已配置' : '默认'}\n` +
        `**拒绝私信：** ${current.conditions.approval.dmTemplates?.rejected ? '已配置' : '默认'}`,
    );

  await interaction.editReply({ embeds: [embed] });
}


/**
 * 处理“配套身份组配置”
 */
async function handleBundleRolesConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);
  const bundle1 = interaction.options.getRole('配套身份组1');
  const bundle2 = interaction.options.getRole('配套身份组2');
  const bundle3 = interaction.options.getRole('配套身份组3');
  const bundle4 = interaction.options.getRole('配套身份组4');
  const bundle5 = interaction.options.getRole('配套身份组5');
  const clear = interaction.options.getBoolean('清空配套身份组') ?? false;

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings) settings = { roles: [] };

  const roleId = role.id;
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);
  if (idx < 0) {
    await interaction.editReply({ content: '❌ 找不到该身份组的配置，请先完成「基础配置」。' });
    return;
  }

  const current = settings.roles[idx];
  const prevList = Array.isArray(current.bundleRoleIds) ? current.bundleRoleIds : [];
  const next = clear ? [] : [...prevList];

  const incoming = [bundle1, bundle2, bundle3, bundle4, bundle5].filter(Boolean);
  for (const r of incoming) {
    if (r.id === roleId) continue;
    if (!next.includes(r.id)) next.push(r.id);
  }

  current.bundleRoleIds = next;
  settings.roles[idx] = current;

  await saveSelfRoleSettings(interaction.guild.id, settings);
  scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'role_bundle_config_updated');

  const bundleText = next.length > 0 ? next.map((rid) => `<@&${rid}>`).join('，') : '（无）';

  const embed = new EmbedBuilder()
    .setTitle('✅ 配套身份组配置成功')
    .setColor(0x57F287)
    .setDescription(`**主身份组：** <@&${roleId}>\n**配套身份组：** ${bundleText}`);

  await interaction.editReply({ embeds: [embed] });
}

/**
 * 处理“申请理由配置”
 */

/**
 * 处理“周期清退配置”
 */
async function handleLifecycleConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);
  const enabledOpt = interaction.options.getBoolean('启用');
  const inquiryDaysOpt = interaction.options.getInteger('询问周期天数');
  const forceRemoveDaysOpt = interaction.options.getInteger('强制清退天数');
  const onlyWhenFullOpt = interaction.options.getBoolean('满员才执行');
  const reportChannel = interaction.options.getChannel('报告频道');
  const reportChannelLink = interaction.options.getString('报告频道链接');

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings) settings = { roles: [] };

  const roleId = role.id;
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);
  if (idx < 0) {
    await interaction.editReply({ content: '❌ 找不到该身份组的配置，请先完成「基础配置」。' });
    return;
  }

  const current = settings.roles[idx];
  if (!current.lifecycle || typeof current.lifecycle !== 'object' || Array.isArray(current.lifecycle)) {
    current.lifecycle = {};
  }

  if (enabledOpt !== null && enabledOpt !== undefined) {
    current.lifecycle.enabled = enabledOpt;
  }
  if (inquiryDaysOpt !== null && inquiryDaysOpt !== undefined) {
    current.lifecycle.inquiryDays = inquiryDaysOpt;
  }
  if (forceRemoveDaysOpt !== null && forceRemoveDaysOpt !== undefined) {
    current.lifecycle.forceRemoveDays = forceRemoveDaysOpt;
  }
  if (onlyWhenFullOpt !== null && onlyWhenFullOpt !== undefined) {
    current.lifecycle.onlyWhenFull = onlyWhenFullOpt;
  }
  if (reportChannel || reportChannelLink) {
    let finalChannel = reportChannel;
    if (!finalChannel) {
      const cid = extractChannelIdFromText(reportChannelLink);
      if (!cid) {
        await interaction.editReply({ content: '❌ 报告频道链接无法解析，请粘贴频道/子区链接或ID。' });
        return;
      }
      finalChannel = await interaction.guild.channels.fetch(cid).catch(() => null);
      if (!finalChannel) {
        await interaction.editReply({ content: '❌ 无法通过“报告频道链接”找到频道/子区，请确认链接或ID正确。' });
        return;
      }
    }

    if (finalChannel.guildId && finalChannel.guildId !== interaction.guild.id) {
      await interaction.editReply({ content: '❌ 报告频道不属于当前服务器，请检查链接。' });
      return;
    }

    // 生命周期报告需要可 send 的 text-based 频道/子区
    if (!finalChannel.isTextBased?.() || finalChannel.type === ChannelType.GuildForum) {
      await interaction.editReply({ content: '❌ 报告频道必须为文字频道或子区（线程）。不支持直接设置为论坛频道。' });
      return;
    }

    current.lifecycle.reportChannelId = finalChannel.id;
  }

  settings.roles[idx] = current;
  await saveSelfRoleSettings(interaction.guild.id, settings);

  const cap = current.conditions?.capacity?.maxMembers;
  const warning = current.lifecycle.onlyWhenFull && !(cap && cap > 0)
    ? '⚠️ 已开启「满员才执行」，但未配置人数上限；系统将无法可靠判断“满员”。建议先设置「人数上限」。'
    : '';

  const enabledText = current.lifecycle.enabled ? '启用' : '未启用';
  const inquiryText = typeof current.lifecycle.inquiryDays === 'number'
    ? (current.lifecycle.inquiryDays > 0 ? `${current.lifecycle.inquiryDays} 天` : '不询问')
    : '（保持不变）';
  const forceText = typeof current.lifecycle.forceRemoveDays === 'number'
    ? (current.lifecycle.forceRemoveDays > 0 ? `${current.lifecycle.forceRemoveDays} 天` : '不强制')
    : '（保持不变）';
  const onlyWhenFullText = typeof current.lifecycle.onlyWhenFull === 'boolean'
    ? (current.lifecycle.onlyWhenFull ? '是' : '否')
    : '（保持不变）';
  const reportText = current.lifecycle.reportChannelId ? `<#${current.lifecycle.reportChannelId}>` : '（未配置）';

  const embed = new EmbedBuilder()
    .setTitle('✅ 周期清退配置成功')
    .setColor(0x57F287)
    .setDescription(
      `**身份组：** <@&${roleId}>\n` +
      `**状态：** ${enabledText}\n` +
      `**询问周期：** ${inquiryText}\n` +
      `**强制清退：** ${forceText}\n` +
      `**满员才执行：** ${onlyWhenFullText}\n` +
      `**报告频道：** ${reportText}` +
      (warning ? `\n\n${warning}` : '')
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleReasonConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);
  const mode = interaction.options.getString('模式') || 'disabled';
  const minLen = interaction.options.getInteger('最小长度') ?? null;
  const maxLen = interaction.options.getInteger('最大长度') ?? null;

  // 数值校验
  if (mode !== 'disabled') {
    if (minLen !== null && minLen <= 0) {
      await interaction.editReply({ content: `❌ 最小长度必须为正整数。` });
      return;
    }
    if (maxLen !== null && maxLen <= 0) {
      await interaction.editReply({ content: `❌ 最大长度必须为正整数。` });
      return;
    }
    if (minLen !== null && maxLen !== null && minLen > maxLen) {
      await interaction.editReply({ content: `❌ 最小长度不得大于最大长度。` });
      return;
    }
  }

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings) settings = { roles: [] };

  const roleId = role.id;
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);

  // 若基础配置不存在，则以身份组名作为默认显示名称创建最小结构
  if (idx < 0) {
    settings.roles.push({
      roleId,
      label: role.name,
      description: '',
      conditions: {},
    });
  }

  const current = settings.roles.find((r) => r.roleId === roleId);
  if (!current.conditions) current.conditions = {};

  if (mode === 'disabled') {
    delete current.conditions.reason;
  } else {
    current.conditions.reason = { mode };
    if (minLen !== null) current.conditions.reason.minLen = minLen;
    if (maxLen !== null) current.conditions.reason.maxLen = maxLen;
  }

  // 回写
  const writeIdx = settings.roles.findIndex((r) => r.roleId === roleId);
  settings.roles[writeIdx] = current;

  await saveSelfRoleSettings(interaction.guild.id, settings);
  scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'role_reason_config_updated');

  const embed = new EmbedBuilder()
    .setTitle('✅ 申请理由配置成功')
    .setColor(0x57F287)
    .setDescription(
      `**身份组：** <@&${roleId}>\n` +
        (mode === 'disabled'
          ? `**申请理由：** 禁用\n`
          : `**申请理由：** ${mode === 'required' ? '必需' : '可选'}\n` +
            `**长度：** ${minLen !== null ? minLen : '默认10'}–${maxLen !== null ? maxLen : '默认500'}\n`),
    );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * 处理“移除配置”
 */
async function handleRemoveConfig(interaction) {
  const role = interaction.options.getRole('目标身份组', true);

  let settings = await getSelfRoleSettings(interaction.guild.id);
  if (!settings || !Array.isArray(settings.roles) || settings.roles.length === 0) {
    await interaction.editReply({ content: '❌ 当前没有任何已配置的身份组。' });
    return;
  }

  const roleId = role.id;
  const idx = settings.roles.findIndex((r) => r.roleId === roleId);

  if (idx < 0) {
    await interaction.editReply({ content: '❌ 找不到该身份组的配置，可能已被移除。' });
    return;
  }

  const removedLabel = settings.roles[idx].label;
  settings.roles.splice(idx, 1);

  await saveSelfRoleSettings(interaction.guild.id, settings);
  await updateMonitoredChannels(interaction.guild.id);
  scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'role_removed');

  const embed = new EmbedBuilder()
    .setTitle('✅ 已移除配置')
    .setColor(0x57F287)
    .setDescription(`**身份组：** <@&${roleId}>\n**显示名称：** ${removedLabel}`);

  await interaction.editReply({ embeds: [embed] });
}

/**
 * 处理“展示已配置身份组”
 */
async function handleListConfig(interaction) {
  const settings = await getSelfRoleSettings(interaction.guild.id);
  const configuredRoles = settings ? settings.roles : [];

  if (!configuredRoles || configuredRoles.length === 0) {
    await interaction.editReply({ content: 'ℹ️ 当前没有配置任何可申请的身份组。' });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 已配置身份组列表')
    .setColor(0x5865F2)
    .setTimestamp();

  let description = '';

  for (const roleConfig of configuredRoles) {
    const roleId = roleConfig.roleId;
    description += `### ${roleConfig.label}（<@&${roleId}>）\n`;
    description += `**ID：** \`${roleId}\`\n`;
    if (roleConfig.description) {
      description += `**描述：** ${roleConfig.description}\n`;
    }

    const conditionsLines = [];

    // 前置身份组
    if (roleConfig.conditions?.prerequisiteRoleId) {
      conditionsLines.push(`- **前置身份组：** <@&${roleConfig.conditions.prerequisiteRoleId}>`);
    }

    // 人数上限
    if (roleConfig.conditions?.capacity?.maxMembers && roleConfig.conditions.capacity.maxMembers > 0) {
      conditionsLines.push(`- **人数上限：** ${roleConfig.conditions.capacity.maxMembers}`);
    }

    // 配套身份组（审核通过/直授时一并授予）
    if (Array.isArray(roleConfig.bundleRoleIds) && roleConfig.bundleRoleIds.length > 0) {
      conditionsLines.push(`- **配套身份组：** ${roleConfig.bundleRoleIds.map((rid) => `<@&${rid}>`).join('，')}`);
    }

    // 活跃度
    if (roleConfig.conditions?.activity) {
      const a = roleConfig.conditions.activity;
      const parts = [];
      if (a.requiredMessages > 0) parts.push(`发言 **${a.requiredMessages}** 次`);
      if (a.requiredMentions > 0) parts.push(`被提及 **${a.requiredMentions}** 次`);
      if (a.requiredMentioning > 0) parts.push(`主动提及 **${a.requiredMentioning}** 次`);

      if (parts.length > 0) {
        conditionsLines.push(`- **活跃度：** 在 <#${a.channelId}> 中 ${parts.join('，')}`);
      } else {
        conditionsLines.push(`- **活跃度：** 在 <#${a.channelId}> 中 无额外阈值`);
      }

      if (a.activeDaysThreshold) {
        conditionsLines.push(
          `- **活跃天数：** 在 <#${a.channelId}> 中每日发言≥**${a.activeDaysThreshold.dailyMessageThreshold}** 条的天数需达到 **${a.activeDaysThreshold.requiredActiveDays}** 天`,
        );
      }
    }

    // 审核
    if (roleConfig.conditions?.approval) {
      const ap = roleConfig.conditions.approval;
      let line = `- **社区审核：** 在 <#${ap.channelId}> 投票（需 ${ap.requiredApprovals} 支持 / ${ap.requiredRejections} 反对）`;
      if (ap.allowedVoterRoles && ap.allowedVoterRoles.length > 0) {
        line += `；审核员：${ap.allowedVoterRoles.map((rid) => `<@&${rid}>`).join('，')}`;
      }
      if (ap.cooldownDays && ap.cooldownDays > 0) {
        line += `；被拒后冷却 **${ap.cooldownDays}** 天`;
      }
      if (ap.dmTemplates?.approved) {
        line += '；已配置通过私信';
      }
      if (ap.dmTemplates?.rejected) {
        line += '；已配置拒绝私信';
      }
      conditionsLines.push(line);
    }

    // 周期清退 / grant 生命周期
    if (roleConfig.lifecycle) {
      const lc = roleConfig.lifecycle;
      const hasAny =
        lc.enabled === true ||
        (typeof lc.inquiryDays === 'number' && lc.inquiryDays > 0) ||
        (typeof lc.forceRemoveDays === 'number' && lc.forceRemoveDays > 0) ||
        lc.onlyWhenFull === true ||
        !!lc.reportChannelId;

      if (hasAny) {
        let line = `- **周期清退：** ${lc.enabled ? '启用' : '未启用'}`;
        if (typeof lc.inquiryDays === 'number') {
          line += lc.inquiryDays > 0 ? `；询问周期 **${lc.inquiryDays}** 天` : '；不询问';
        }
        if (typeof lc.forceRemoveDays === 'number') {
          line += lc.forceRemoveDays > 0 ? `；强制清退 **${lc.forceRemoveDays}** 天` : '；不强制';
        }
        if (lc.onlyWhenFull) {
          line += '；仅满员执行';
        }
        if (lc.reportChannelId) {
          line += `；报告频道 <#${lc.reportChannelId}>`;
        }
        conditionsLines.push(line);
      }
    }

    // 申请理由
    if (roleConfig.conditions?.reason) {
      const rc = roleConfig.conditions.reason;
      const modeText = rc.mode === 'required' ? '必需' : rc.mode === 'optional' ? '可选' : '禁用';
      let line = `- **申请理由：** ${modeText}`;
      if (rc.mode !== 'disabled') {
        const minText = typeof rc.minLen === 'number' ? rc.minLen : '默认10';
        const maxText = typeof rc.maxLen === 'number' ? rc.maxLen : '默认500';
        line += `；长度 ${minText}–${maxText}`;
      }
      conditionsLines.push(line);
    }

    if (conditionsLines.length > 0) {
      description += `**申请条件：**\n${conditionsLines.join('\n')}\n`;
    } else {
      description += `**申请条件：** 无\n`;
    }

    description += '---\n';
  }

  embed.setDescription(description);
  await interaction.editReply({ embeds: [embed] });
}