// src/modules/channelArchive/store/instance.js
const { ArchiveStore } = require('./database');

let store = null;

function initStore(filename) {
    if (!store) store = new ArchiveStore(filename);
    return store;
}

function getStore() {
    if (!store) store = new ArchiveStore();
    return store;
}

function closeStore() {
    if (store) {
        store.close();
        store = null;
    }
}

module.exports = {
    initStore,
    getStore,
    closeStore,
};
