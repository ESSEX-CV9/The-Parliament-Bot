// src/modules/channelArchive/services/hooks.js
const handlers = {
    onArchivePassed: null,
    onDeletePassed: null,
};

function setVoteHandlers(next = {}) {
    if (typeof next.onArchivePassed === 'function') handlers.onArchivePassed = next.onArchivePassed;
    if (typeof next.onDeletePassed === 'function') handlers.onDeletePassed = next.onDeletePassed;
}

function getVoteHandlers() {
    return handlers;
}

module.exports = {
    setVoteHandlers,
    getVoteHandlers,
};
