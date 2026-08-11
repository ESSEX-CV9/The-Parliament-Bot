const CHANNEL_ACCESS_SOURCES = Object.freeze({
    DEFAULT: 'default',
    DIRECT_BLACKLIST: 'direct_blacklist',
    DIRECT_WHITELIST: 'direct_whitelist',
    PARENT_BLACKLIST: 'parent_blacklist',
    PARENT_WHITELIST: 'parent_whitelist',
});

function resolveChannelAccess(channel, config = {}) {
    const blacklist = new Set(Array.isArray(config.blacklist) ? config.blacklist : []);
    const whitelist = new Set(Array.isArray(config.whitelist) ? config.whitelist : []);

    if (blacklist.has(channel.id)) {
        return { allowed: false, source: CHANNEL_ACCESS_SOURCES.DIRECT_BLACKLIST };
    }

    if (whitelist.has(channel.id)) {
        return { allowed: true, source: CHANNEL_ACCESS_SOURCES.DIRECT_WHITELIST };
    }

    if (blacklist.has(channel.parentId)) {
        return { allowed: false, source: CHANNEL_ACCESS_SOURCES.PARENT_BLACKLIST };
    }

    if (whitelist.has(channel.parentId)) {
        return { allowed: true, source: CHANNEL_ACCESS_SOURCES.PARENT_WHITELIST };
    }

    return {
        allowed: channel.isThread() === true,
        source: CHANNEL_ACCESS_SOURCES.DEFAULT,
    };
}

module.exports = {
    CHANNEL_ACCESS_SOURCES,
    resolveChannelAccess,
};
