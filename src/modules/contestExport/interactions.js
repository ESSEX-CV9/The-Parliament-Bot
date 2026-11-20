// src/modules/contestExport/interactions.js
// 归档面板「查询作品」按钮与弹窗。任何能看到面板的人都可用，结果仅自己可见，只读。
const { MessageFlags } = require('discord.js');
const {
    SEARCH_BUTTON,
    SEARCH_MODAL,
    loadContest,
    searchSubmissions,
    buildSearchReply,
    buildSearchModal,
} = require('./services/archivePanel');

const contestDatabase = () => require('../contest/utils/contestDatabase');

function createArchivePanelHandler({
    readContest = async id => contestDatabase().getAllContestChannels()[id] || null,
    readSubmissions = async id => contestDatabase().getSubmissionsByChannel(id),
} = {}) {
    return async function handleArchivePanelInteraction(interaction) {
        const customId = interaction.customId || '';
        if (interaction.isButton() && customId.startsWith(SEARCH_BUTTON)) {
            return interaction.showModal(buildSearchModal(customId.slice(SEARCH_BUTTON.length)));
        }
        if (interaction.isModalSubmit() && customId.startsWith(SEARCH_MODAL)) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channelId = customId.slice(SEARCH_MODAL.length);
            const keyword = interaction.fields.getTextInputValue('keyword');
            const contest = loadContest(await readContest(channelId), await readSubmissions(channelId), channelId);
            if (!contest) return interaction.editReply({ content: '❌ 找不到这个赛事的数据。' });
            return interaction.editReply(buildSearchReply(contest, keyword, searchSubmissions(contest, keyword)));
        }
        return undefined;
    };
}

module.exports = { createArchivePanelHandler, handleArchivePanelInteraction: createArchivePanelHandler() };
