const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { ProgressReporter } = require('../utils/progressReporter');
const { runBackup } = require('../services/orchestrator');

const activeBackups = new Set();
const EPHEMERAL = MessageFlags.Ephemeral;

const data = new SlashCommandBuilder()
  .setName('backup')
  .setDescription('备份服务器数据并发送到指定地址')
  .addSubcommand(sub =>
    sub.setName('server')
      .setDescription('备份整个服务器')
      .addStringOption(opt =>
        opt.setName('destination')
          .setDescription('接收备份的 HTTP URL')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('备份单个频道及其子区/帖子')
      .addStringOption(opt =>
        opt.setName('target')
          .setDescription('要备份的频道 ID')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('destination')
          .setDescription('接收备份的 HTTP URL')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('category')
      .setDescription('备份分类下所有频道')
      .addStringOption(opt =>
        opt.setName('target')
          .setDescription('要备份的分类 ID')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('destination')
          .setDescription('接收备份的 HTTP URL')
          .setRequired(true)));

async function execute(interaction) {
  if (!checkAdminPermission(interaction.member)) {
    return interaction.reply({ content: '❌ 你没有权限执行备份操作。', flags: EPHEMERAL });
  }

  const guildId = interaction.guildId;
  if (activeBackups.has(guildId)) {
    return interaction.reply({ content: '⏳ 当前服务器已有备份任务在运行，请等待完成。', flags: EPHEMERAL });
  }

  const destination = interaction.options.getString('destination');
  try {
    new URL(destination);
  } catch {
    return interaction.reply({ content: '❌ 无效的目标 URL。', flags: EPHEMERAL });
  }

  const type = interaction.options.getSubcommand();
  const targetId = interaction.options.getString('target');
  let target = null;

  if (targetId) {
    target = interaction.guild.channels.cache.get(targetId);
    if (!target) {
      return interaction.reply({ content: `❌ 找不到 ID 为 \`${targetId}\` 的频道或分类。`, flags: EPHEMERAL });
    }
    if (type === 'category' && target.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: `❌ ID \`${targetId}\` 不是一个分类频道。`, flags: EPHEMERAL });
    }
    if (type === 'channel' && target.type === ChannelType.GuildCategory) {
      return interaction.reply({ content: `❌ ID \`${targetId}\` 是一个分类，请使用 \`/backup category\`。`, flags: EPHEMERAL });
    }
  }

  await interaction.deferReply({ flags: EPHEMERAL });
  await interaction.editReply({ content: '📦 备份任务已开始，进度将通过私信发送。' });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
  activeBackups.add(guildId);

  const reporter = new ProgressReporter(interaction.user);
  await reporter.init();

  try {
    await runBackup({
      type,
      target,
      destination,
      guild: interaction.guild,
      reporter,
    });
  } catch (err) {
    console.error('Backup failed:', err);
    await reporter.fail(`备份过程中发生致命错误：${err.message}`);
  } finally {
    activeBackups.delete(guildId);
  }
}

module.exports = { data, execute };
