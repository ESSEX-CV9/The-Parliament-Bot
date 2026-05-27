const { ChannelType } = require('discord.js');
const { PassThrough } = require('stream');
const { fetchChannelMetadata, fetchChannelPermissions } = require('../fetchers/channelFetcher');
const { fetchAllMessages } = require('../fetchers/messageFetcher');
const { fetchThreads } = require('../fetchers/threadFetcher');
const { streamAttachmentToArchive } = require('../fetchers/attachmentFetcher');
const { createDiskArchive } = require('./archiver');
const { uploadFile } = require('./uploader');
const { cleanupFile } = require('../utils/cleanup');

const TEXT_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;

function sanitizeName(name) {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!safe || WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe;
}

function getPathSegments(ch, parentChannel) {
  if (ch.isThread?.()) {
    const parent = parentChannel || ch.parent;
    const categoryName = parent?.parent?.name || '未分类';
    return [sanitizeName(categoryName), sanitizeName(parent.name), sanitizeName(ch.name), sanitizeName(ch.name)];
  }
  const categoryName = ch.parent?.name || '未分类';
  return [sanitizeName(categoryName), sanitizeName(ch.name), sanitizeName(ch.name)];
}

async function runBackup({ type, target, destination, guild, reporter }) {
  const startTime = Date.now();
  const channels = resolveChannels(type, target, guild);
  reporter.data.totalChannels = channels.length;

  const backupId = `${guild.id}_${Date.now()}`;
  const baseUrl = `${destination.replace(/\/+$/, '')}/${backupId}`;

  let totalMessages = 0;
  let totalAttachments = 0;
  const errors = [];
  const manifest = [];

  await reporter.update({ phase: '正在写入服务器信息' });
  await uploadSingleArchive(
    backupId,
    `${baseUrl}/server`,
    (archive) => {
      archive.append(
        JSON.stringify(buildServerMetadata(guild), null, 2),
        { name: 'server_metadata.json' },
      );
    },
  );
  manifest.push({ id: 'server', type: 'metadata' });

  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    await reporter.update({
      phase: `处理频道: ${channel.name}`,
      processedChannels: i,
    });

    const channelsToProcess = [channel];

    const canHaveThreads = TEXT_CHANNEL_TYPES.has(channel.type) && channel.threads;
    if (canHaveThreads) {
      try {
        const threads = await fetchThreads(channel, errors);
        channelsToProcess.push(...threads);
      } catch (err) {
        errors.push(`获取子区失败 [${channel.name}]: ${err.message}`);
      }
    }

    for (const ch of channelsToProcess) {
      const segments = getPathSegments(ch, channel);
      const partUrl = `${baseUrl}/${segments.map(s => encodeURIComponent(s)).join('/')}`;
      let partMessages = 0;
      let partAttachments = 0;

      await reporter.update({
        phase: ch.isThread?.() ? `处理帖子: ${ch.name}` : `处理频道: ${ch.name}`,
      });

      let tempFilePath;
      try {
        const result = await packChannel(ch, backupId, async (stats) => {
          partMessages += stats.messages || 0;
          partAttachments += stats.attachments || 0;
          totalMessages += stats.messages || 0;
          totalAttachments += stats.attachments || 0;
          await reporter.update({ totalMessages, totalAttachments });
        }, errors);

        tempFilePath = result.tempFilePath;

        await reporter.update({ phase: `上传: ${ch.name}` });
        await uploadFile(tempFilePath, partUrl);

        manifest.push({
          id: ch.id,
          name: ch.name,
          type: ch.isThread?.() ? 'thread' : 'channel',
          channelType: ch.type,
          parentId: ch.parentId || null,
          path: segments.join('/') + '.zip',
          messages: partMessages,
          attachments: partAttachments,
        });
      } catch (err) {
        errors.push(`处理失败 [${ch.name}]: ${err.message}`);
      } finally {
        if (tempFilePath) await cleanupFile(tempFilePath);
      }
    }

    reporter.data.errors = errors;
    await reporter.update({ processedChannels: i + 1 });
  }

  await reporter.update({ phase: '正在上传备份清单' });
  await uploadSingleArchive(
    backupId,
    `${baseUrl}/manifest`,
    (archive) => {
      archive.append(
        JSON.stringify({
          backupId,
          guildId: guild.id,
          guildName: guild.name,
          backupTime: new Date().toISOString(),
          parts: manifest,
          totalMessages,
          totalAttachments,
          errors,
        }, null, 2),
        { name: 'manifest.json' },
      );
    },
  );

  const duration = formatDuration(Date.now() - startTime);
  await reporter.complete({
    channels: channels.length,
    messages: totalMessages,
    attachments: totalAttachments,
    duration,
    errors: errors.length,
  });
}

async function packChannel(ch, backupId, onProgress, errors) {
  const { archive, tempFilePath, finalize } = await createDiskArchive(`${backupId}_${ch.id}`);

  try {
    archive.append(
      JSON.stringify(fetchChannelMetadata(ch), null, 2),
      { name: 'metadata.json' },
    );
    archive.append(
      JSON.stringify(fetchChannelPermissions(ch), null, 2),
      { name: 'permissions.json' },
    );

    if (ch.isTextBased()) {
      const attachmentsToStream = [];
      const messagesStream = new PassThrough();
      archive.append(messagesStream, { name: 'messages.json' });

      let firstBatch = true;
      messagesStream.write('[\n');

      try {
        await fetchAllMessages(ch, async (batch, fetched) => {
          for (const msg of batch) {
            attachmentsToStream.push(...msg.attachments);
          }
          for (const msg of batch) {
            if (!firstBatch) messagesStream.write(',\n');
            messagesStream.write(JSON.stringify(msg, null, 2));
            firstBatch = false;
          }
          await onProgress({ messages: batch.length, attachments: 0 });
        });
      } catch (err) {
        errors.push(`抓取消息失败 [${ch.name}]: ${err.message}`);
      }

      messagesStream.write('\n]');
      messagesStream.end();

      for (const att of attachmentsToStream) {
        try {
          const added = await streamAttachmentToArchive(att, archive, '');
          if (added) await onProgress({ messages: 0, attachments: 1 });
        } catch (err) {
          errors.push(`附件下载失败 [${att.filename}]: ${err.message}`);
        }
      }
    }

    await finalize();
  } catch (err) {
    archive.abort();
    await cleanupFile(tempFilePath);
    throw err;
  }

  return { tempFilePath };
}

async function uploadSingleArchive(backupId, url, populateFn) {
  const { archive, tempFilePath, finalize } = await createDiskArchive(backupId);
  try {
    populateFn(archive);
    await finalize();
    await uploadFile(tempFilePath, url);
  } finally {
    await cleanupFile(tempFilePath);
  }
}

function buildServerMetadata(guild) {
  return {
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    createdTimestamp: guild.createdTimestamp,
    backupTime: new Date().toISOString(),
    icon: guild.icon,
    banner: guild.banner,
    splash: guild.splash,
    description: guild.description,
    preferredLocale: guild.preferredLocale,
    verificationLevel: guild.verificationLevel,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    explicitContentFilter: guild.explicitContentFilter,
    features: [...guild.features],
    systemChannelId: guild.systemChannelId,
    rulesChannelId: guild.rulesChannelId,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    afkChannelId: guild.afkChannelId,
    afkTimeout: guild.afkTimeout,
    roles: guild.roles.cache
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        position: r.position,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
        managed: r.managed,
        icon: r.icon,
        unicodeEmoji: r.unicodeEmoji,
      })),
    emojis: guild.emojis.cache.map(e => ({
      id: e.id,
      name: e.name,
      animated: e.animated,
    })),
    categories: guild.channels.cache
      .filter(c => c.type === ChannelType.GuildCategory)
      .sort((a, b) => a.position - b.position)
      .map(c => ({
        id: c.id,
        name: c.name,
        position: c.position,
        permissionOverwrites: c.permissionOverwrites.cache.map(ow => ({
          id: ow.id,
          type: ow.type,
          allow: ow.allow.bitfield.toString(),
          deny: ow.deny.bitfield.toString(),
        })),
      })),
  };
}

function resolveChannels(type, target, guild) {
  const all = guild.channels.cache;

  if (type === 'server') {
    return all.filter(c => TEXT_CHANNEL_TYPES.has(c.type)).sort((a, b) => a.position - b.position).toJSON();
  }
  if (type === 'channel') {
    return [target];
  }
  if (type === 'category') {
    return all
      .filter(c => c.parentId === target.id && TEXT_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => a.position - b.position)
      .toJSON();
  }
  return [];
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒`;
}

module.exports = { runBackup };
