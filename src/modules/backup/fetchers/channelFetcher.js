const { ChannelType } = require('discord.js');

function fetchChannelMetadata(channel) {
  const meta = {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    topic: channel.topic || null,
    position: channel.position,
    nsfw: channel.nsfw || false,
    rateLimitPerUser: channel.rateLimitPerUser || 0,
    parentId: channel.parentId || null,
    createdTimestamp: channel.createdTimestamp,
    bitrate: channel.bitrate || null,
    userLimit: channel.userLimit || null,
  };

  if (channel.isThread?.()) {
    meta.archived = channel.archived ?? null;
    meta.locked = channel.locked ?? null;
    meta.autoArchiveDuration = channel.autoArchiveDuration ?? null;
    meta.invitable = channel.invitable ?? null;
    meta.appliedTags = channel.appliedTags ?? [];
    meta.flags = channel.flags?.bitfield ?? 0;
    meta.ownerId = channel.ownerId ?? null;
    meta.memberCount = channel.memberCount ?? null;
    meta.messageCount = channel.messageCount ?? null;
    meta.archiveTimestamp = channel.archiveTimestamp ?? null;
    meta.totalMessageSent = channel.totalMessageSent ?? null;
  }

  if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    meta.availableTags = (channel.availableTags ?? []).map(tag => ({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated,
      emoji: tag.emoji ? { id: tag.emoji.id, name: tag.emoji.name } : null,
    }));
    meta.defaultAutoArchiveDuration = channel.defaultAutoArchiveDuration ?? null;
    meta.defaultThreadRateLimitPerUser = channel.defaultThreadRateLimitPerUser ?? null;
    meta.defaultSortOrder = channel.defaultSortOrder ?? null;
    meta.defaultReactionEmoji = channel.defaultReactionEmoji ?? null;
  }

  if (channel.type === ChannelType.GuildForum) {
    meta.defaultForumLayout = channel.defaultForumLayout ?? 0;
  }

  return meta;
}

function fetchChannelPermissions(channel) {
  if (!channel.permissionOverwrites) return [];
  return channel.permissionOverwrites.cache.map(overwrite => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
}

module.exports = { fetchChannelMetadata, fetchChannelPermissions };
