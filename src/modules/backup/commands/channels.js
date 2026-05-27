const { SlashCommandBuilder, ChannelType, AttachmentBuilder } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { fetchThreads } = require('../fetchers/threadFetcher');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ICON = {
  [ChannelType.GuildText]: '\u{1F4AC}',
  [ChannelType.GuildAnnouncement]: '\u{1F4E2}',
  [ChannelType.GuildForum]: '\u{1F5E8}️',
  [ChannelType.GuildStageVoice]: '\u{1F3A4}',
  [ChannelType.GuildVoice]: '\u{1F50A}',
  [ChannelType.GuildMedia]: '\u{1F3AC}',
};

const data = new SlashCommandBuilder()
  .setName('channels')
  .setDescription('列出全服所有类别、频道、子区及其 ID');

async function execute(interaction) {
  if (!checkAdminPermission(interaction.member)) {
    return interaction.reply({ content: '❌ 你没有权限执行此操作。', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: '\u{1F4CB} 正在获取频道列表，将通过私信发送。' });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

  const guild = interaction.guild;
  const channels = guild.channels.cache;

  const categories = new Map();
  const uncategorized = [];

  for (const ch of channels.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      if (!categories.has(ch.id)) {
        categories.set(ch.id, { name: ch.name, id: ch.id, position: ch.position, children: [] });
      }
    }
  }

  for (const ch of channels.values()) {
    if (ch.type === ChannelType.GuildCategory) continue;
    if (ch.isThread()) continue;

    const entry = { name: ch.name, id: ch.id, type: ch.type, position: ch.position, threads: [] };

    const canHaveThreads = [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ].includes(ch.type);

    if (canHaveThreads && ch.threads) {
      const threads = await fetchThreads(ch);
      for (const t of threads) {
        entry.threads.push({ name: t.name, id: t.id });
      }
      await sleep(100);
    }

    if (ch.parentId && categories.has(ch.parentId)) {
      categories.get(ch.parentId).children.push(entry);
    } else {
      uncategorized.push(entry);
    }
  }

  const sortedCategories = [...categories.values()].sort((a, b) => a.position - b.position);
  uncategorized.sort((a, b) => a.position - b.position);

  const lines = [];

  for (const cat of sortedCategories) {
    lines.push(`\u{1F4C1} ${cat.name} (${cat.id})`);
    cat.children.sort((a, b) => a.position - b.position);
    for (const ch of cat.children) {
      const icon = ICON[ch.type] || '\u{1F4AC}';
      lines.push(`  ${icon} ${ch.name} (${ch.id})`);
      for (const t of ch.threads) {
        lines.push(`    \u{1F9F5} ${t.name} (${t.id})`);
      }
    }
  }

  if (uncategorized.length > 0) {
    lines.push(`── 未分类 ──`);
    for (const ch of uncategorized) {
      const icon = ICON[ch.type] || '\u{1F4AC}';
      lines.push(`  ${icon} ${ch.name} (${ch.id})`);
      for (const t of ch.threads) {
        lines.push(`    \u{1F9F5} ${t.name} (${t.id})`);
      }
    }
  }

  const content = lines.join('\n');
  const buffer = Buffer.from(content, 'utf-8');
  const attachment = new AttachmentBuilder(buffer, {
    name: `${guild.name}_channels_${Date.now()}.txt`,
  });

  try {
    const dm = await interaction.user.createDM();
    await dm.send({ files: [attachment] });
  } catch {
    await interaction.followUp({ content: '❌ 无法发送私信，请检查你的私信设置。', ephemeral: true });
  }
}

module.exports = { data, execute };
