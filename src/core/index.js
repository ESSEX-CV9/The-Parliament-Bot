// src/core/index.js
require('dotenv').config();

const {
    Client,
    Collection,
    Events, 
    GatewayIntentBits,
} = require('discord.js')

const { clientReadyHandler } = require('./events/clientReady')
const { interactionCreateHandler } = require('./events/interactionCreate')
const { startProposalChecker } = require('../modules/proposal/services/proposalChecker');
const { startCourtChecker } = require('../modules/court/services/courtChecker');
const { startSelfModerationChecker } = require('../modules/selfModeration/services/moderationChecker');
const { startAttachmentCleanupScheduler } = require('../modules/selfModeration/services/archiveService');
const { startVoteChecker } = require('../modules/voting/services/voteChecker');
const { startElectionScheduler } = require('../modules/election/services/electionScheduler');
const { printTimeConfig } = require('./config/timeconfig');
const { startActivityTracker } = require('../modules/selfRole/services/activityTracker');
const { syncMissedActivity } = require('../modules/selfRole/services/autoSyncService');

// 身份组同步系统（多服务器）
const {
    startRoleSyncSystem,
    roleSyncGuildMemberAddHandler,
    roleSyncGuildMemberRemoveHandler,
    roleSyncGuildMemberUpdateHandler,
    roleSyncGuildRoleDeleteHandler,
} = require('../modules/roleSync');

// 导入命令
const pingCommand = require('../shared/commands/ping');
// const debugPermissionsCommand = require('../shared/commands/debugPermissions');  // 需要使用再取消注释
const setCheckChannelCommand = require('../shared/commands/setCheckChannel');

// 提案系统命令
const setupFormCommand = require('../modules/proposal/commands/setupForm');
const deleteEntryCommand = require('../modules/proposal/commands/deleteEntry');
const withdrawProposalCommand = require('../modules/proposal/commands/withdrawProposal');
const setFormPermissionsCommand = require('../modules/proposal/commands/setFormPermissions');
const setSupportPermissionsCommand = require('../modules/proposal/commands/setSupportPermissions');
const reviewProposalCommand = require('../modules/proposal/commands/reviewProposal');
const setProposalReviewersCommand = require('../modules/proposal/commands/setProposalReviewers');

// 审核系统命令
const setupReviewCommand = require('../modules/creatorReview/commands/setupReview');
const deleteReviewEntryCommand = require('../modules/creatorReview/commands/deleteReviewEntry');
const addAllowPreviewServerCommand = require('../modules/creatorReview/commands/addAllowPreviewServer');
const removeAllowPreviewServerCommand = require('../modules/creatorReview/commands/removeAllowPreviewServer');
const addAllowedForumCommand = require('../modules/creatorReview/commands/addAllowedForum'); 
const removeAllowedForumCommand = require('../modules/creatorReview/commands/removeAllowedForum');

// 法庭系统命令
const setAllowCourtRoleCommand = require('../modules/court/commands/setAllowCourtRole');
const applyToCourtCommand = require('../modules/court/commands/applyToCourt');

// 自助管理系统命令
const deleteShitMessageCommand = require('../modules/selfModeration/commands/deleteShitMessage');
const muteShitUserCommand = require('../modules/selfModeration/commands/muteShitUser');
const seriousMuteCommand = require('../modules/selfModeration/commands/seriousMute');
const setSelfModerationRolesCommand = require('../modules/selfModeration/commands/setSelfModerationRoles');
const setSelfModerationChannelsCommand = require('../modules/selfModeration/commands/setSelfModerationChannels');
const setSelfModerationCooldownCommand = require('../modules/selfModeration/commands/setSelfModerationCooldown');
const setMessageTimeLimitCommand = require('../modules/selfModeration/commands/setMessageTimeLimit');
const checkMyCooldownCommand = require('../modules/selfModeration/commands/checkMyCooldown');
const setArchiveChannelCommand = require('../modules/selfModeration/commands/setArchiveChannel');
const setArchiveViewRoleCommand = require('../modules/selfModeration/commands/setArchiveViewRole');
const getArchiveViewPermissionCommand = require('../modules/selfModeration/commands/getArchiveViewPermission');
const manageAttachmentCleanupCommand = require('../modules/selfModeration/commands/manageAttachmentCleanup');
const manageSelfModerationBlacklistCommand = require('../modules/selfModeration/commands/manageSelfModerationBlacklist');

// 赛事系统命令
const setupContestApplicationCommand = require('../modules/contest/commands/setupContestApplication');
const manageTrackCommand = require('../modules/contest/commands/manageTrack');
const setContestReviewersCommand = require('../modules/contest/commands/setContestReviewers');
const reviewContestApplicationCommand = require('../modules/contest/commands/reviewContestApplication');
const updateContestInfoCommand = require('../modules/contest/commands/updateContestInfo');
const updateContestTitleCommand = require('../modules/contest/commands/updateContestTitle');
const initContestTagsCommand = require('../modules/contest/commands/initContestTags');
const manageAllowedForumsCommand = require('../modules/contest/commands/manageAllowedForums');
const manageExternalServersCommand = require('../modules/contest/commands/manageExternalServers');
const cacheStats = require('../modules/contest/commands/cacheStats');
const regenerateContestMessagesCommand = require('../modules/contest/commands/regenerateContestMessages');
const bindParticipantRoleCommand = require('../modules/contest/commands/bindParticipantRole');
const manageParticipantRoleCommand = require('../modules/contest/commands/manageParticipantRole');
const setExternalSubmissionOptInCommand = require('../modules/contest/commands/setExternalSubmissionOptIn');
const viewSubmissionsCommand = require('../modules/contest/commands/viewSubmissions');
const viewSubmissionsContextCommand = require('../modules/contest/commands/viewSubmissionsContext');

// 自动清理系统命令
const addBannedKeywordCommand = require('../modules/autoCleanup/commands/addBannedKeyword');
const removeBannedKeywordCommand = require('../modules/autoCleanup/commands/removeBannedKeyword');
const listBannedKeywordsCommand = require('../modules/autoCleanup/commands/listBannedKeywords');
const setCleanupChannelsCommand = require('../modules/autoCleanup/commands/setCleanupChannels');
const cleanupHistoryCommand = require('../modules/autoCleanup/commands/cleanupHistory');
const cleanupFullServerCommand = require('../modules/autoCleanup/commands/cleanupFullServer');
const stopCleanupTaskCommand = require('../modules/autoCleanup/commands/stopCleanupTask');
const cleanupStatusCommand = require('../modules/autoCleanup/commands/cleanupStatus');
const toggleAutoCleanupCommand = require('../modules/autoCleanup/commands/toggleAutoCleanup');
// 豁免频道命令
const addExemptChannelCommand = require('../modules/autoCleanup/commands/addExemptChannel');
const removeExemptChannelCommand = require('../modules/autoCleanup/commands/removeExemptChannel');
const listExemptChannelsCommand = require('../modules/autoCleanup/commands/listExemptChannels');
const cleanupSelectedChannelsCommand = require('../modules/autoCleanup/commands/cleanupSelectedChannels');

// 频道总结系统命令
const summarizeChannelCommand = require('../modules/channelSummary/commands/summarizeChannel');

// 投票系统命令
const createVoteCommand = require('../modules/voting/commands/createVote');
// 添加新的通知身份组命令
const notificationRolesCommand = require('../modules/voting/commands/notificationRoles');

// 选举系统命令 - 完整的命令列表
const setElectionPositionsCommand = require('../modules/election/commands/setElectionPositions');
const setElectionTimeScheduleCommand = require('../modules/election/commands/setElectionTimeSchedule');
const setupElectionEntryCommand = require('../modules/election/commands/setupElectionEntry');
const getElectionStatusCommand = require('../modules/election/commands/getElectionStatus');
const setRegistrationRolesCommand = require('../modules/election/commands/setRegistrationRoles');
const setVotingRolesCommand = require('../modules/election/commands/setVotingRoles');
const setNotificationRolesCommand = require('../modules/election/commands/setNotificationRoles');
const getTieAnalysisCommand = require('../modules/election/commands/getTieAnalysis');
const reprocessElectionResultsCommand = require('../modules/election/commands/reprocessElectionResults');
const viewCandidateInfoCommand = require('../modules/election/commands/viewCandidateInfo');
const manageCandidateStatusCommand = require('../modules/election/commands/manageCandidateStatus');
const scanCandidateMessagesCommand = require('../modules/election/commands/scanCandidateMessages');
const editCandidateInfoCommand = require('../modules/election/commands/editCandidateInfo');
const clearElectionVoteCommand = require('../modules/election/commands/clearElectionVote');
const viewVoteRemovalLogsCommand = require('../modules/election/commands/viewVoteRemovalLogs');
const updateVotingCandidatesCommand = require('../modules/election/commands/updateVotingCandidates');

const { messageCreateHandler } = require('./events/messageCreate');

// 论坛重建系统命令
const rebuildForumCommand = require('../modules/forumRebuilder/commands/rebuildForum');

// 帖子重建系统命令
const rebuildThreadsCommand = require('../modules/threadRebuilder/commands/rebuildThreads');
const deleteRebuiltMessageCommand = require('../modules/threadRebuilder/commands/deleteRebuiltMessage');

// 自助文件上传系统命令
const uploadCommand = require('../modules/selfFileUpload/commands/uploadFile');
const whoisCommand = require('../modules/selfFileUpload/commands/queryAnonymousLog');
const manageOptOutCommand = require('../modules/selfFileUpload/commands/manageOptOut.js');
const collectBackupsCommand = require('../modules/selfFileUpload/commands/collectBackups.js');

// 补卡系统命令
const processBackupCardsCommand = require('../modules/backupCards/commands/processBackupCards');
const testBackupCardsCommand = require('../modules/backupCards/commands/testBackupCards');
const archiveBackupThreadsCommand = require('../modules/backupCards/commands/archiveBackupThreads');
const cleanupFuzzyMatchesCommand = require('../modules/backupCards/commands/cleanupFuzzyMatches');

//// 自助身份组系统命令
const setupRolePanelCommand = require('../modules/selfRole/commands/setupRolePanel');
const setupAdminPanelCommand = require('../modules/selfRole/commands/setupAdminPanel');
const recalculateActivityCommand = require('../modules/selfRole/commands/recalculateActivity');
const checkActivityCommand = require('../modules/selfRole/commands/checkActivity');
const debugRolesCommand = require('../modules/selfRole/commands/debugRoles'); // 调试命令
const clearCooldownCommand = require('../modules/selfRole/commands/clearCooldown');
const configureRolesCommand = require('../modules/selfRole/commands/configureRoles');

// 身份组同步系统命令
const roleSyncConfigCommand = require('../modules/roleSync/commands/roleSyncConfig');

// 处罚系统
const { startPunishmentSystem } = require('../modules/punishment');
const punishCommand = require('../modules/punishment/commands/punish');

// 分服受控邀请系统
const { startControlledInviteSystem, controlledInviteGuildMemberAddHandler } = require('../modules/controlledInvite');
const controlledInviteConfigCommand = require('../modules/controlledInvite/commands/controlledInviteConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions, // 需要这个intent来监控reaction
        GatewayIntentBits.MessageContent,
    ],
    rest: {
        requestTimeout: 60000, // 将超时时间设置为 60 秒
    },
});

client.commands = new Collection();

// 注册所有命令
client.commands.set(pingCommand.data.name, pingCommand);
// client.commands.set(debugPermissionsCommand.data.name, debugPermissionsCommand); // 需要使用再取消注释
client.commands.set(setCheckChannelCommand.data.name, setCheckChannelCommand);

// 提案系统命令
client.commands.set(setupFormCommand.data.name, setupFormCommand);
client.commands.set(deleteEntryCommand.data.name, deleteEntryCommand);
client.commands.set(withdrawProposalCommand.data.name, withdrawProposalCommand);
client.commands.set(setFormPermissionsCommand.data.name, setFormPermissionsCommand);
client.commands.set(setSupportPermissionsCommand.data.name, setSupportPermissionsCommand);
client.commands.set(reviewProposalCommand.data.name, reviewProposalCommand);
client.commands.set(setProposalReviewersCommand.data.name, setProposalReviewersCommand);

// 审核系统命令
client.commands.set(setupReviewCommand.data.name, setupReviewCommand);
client.commands.set(deleteReviewEntryCommand.data.name, deleteReviewEntryCommand);
client.commands.set(addAllowPreviewServerCommand.data.name, addAllowPreviewServerCommand);
client.commands.set(removeAllowPreviewServerCommand.data.name, removeAllowPreviewServerCommand);
client.commands.set(addAllowedForumCommand.data.name, addAllowedForumCommand);
client.commands.set(removeAllowedForumCommand.data.name, removeAllowedForumCommand);

// 法庭系统命令
client.commands.set(setAllowCourtRoleCommand.data.name, setAllowCourtRoleCommand);
client.commands.set(applyToCourtCommand.data.name, applyToCourtCommand);

// 自助管理系统命令
client.commands.set(deleteShitMessageCommand.data.name, deleteShitMessageCommand);
client.commands.set(muteShitUserCommand.data.name, muteShitUserCommand);
client.commands.set(seriousMuteCommand.data.name, seriousMuteCommand);
client.commands.set(setSelfModerationRolesCommand.data.name, setSelfModerationRolesCommand);
client.commands.set(setSelfModerationChannelsCommand.data.name, setSelfModerationChannelsCommand);
client.commands.set(setSelfModerationCooldownCommand.data.name, setSelfModerationCooldownCommand);
client.commands.set(setMessageTimeLimitCommand.data.name, setMessageTimeLimitCommand);
client.commands.set(checkMyCooldownCommand.data.name, checkMyCooldownCommand);
client.commands.set(setArchiveChannelCommand.data.name, setArchiveChannelCommand);
client.commands.set(setArchiveViewRoleCommand.data.name, setArchiveViewRoleCommand);
client.commands.set(getArchiveViewPermissionCommand.data.name, getArchiveViewPermissionCommand);
client.commands.set(manageAttachmentCleanupCommand.data.name, manageAttachmentCleanupCommand);
client.commands.set(manageSelfModerationBlacklistCommand.data.name, manageSelfModerationBlacklistCommand);

// 赛事系统命令
client.commands.set(setupContestApplicationCommand.data.name, setupContestApplicationCommand);
client.commands.set(manageTrackCommand.data.name, manageTrackCommand);
client.commands.set(setContestReviewersCommand.data.name, setContestReviewersCommand);
client.commands.set(reviewContestApplicationCommand.data.name, reviewContestApplicationCommand);
client.commands.set(updateContestInfoCommand.data.name, updateContestInfoCommand);
client.commands.set(updateContestTitleCommand.data.name, updateContestTitleCommand);
client.commands.set(initContestTagsCommand.data.name, initContestTagsCommand);
client.commands.set(manageAllowedForumsCommand.data.name, manageAllowedForumsCommand);
client.commands.set(manageExternalServersCommand.data.name, manageExternalServersCommand);
client.commands.set(cacheStats.data.name, cacheStats);
client.commands.set(regenerateContestMessagesCommand.data.name, regenerateContestMessagesCommand);
client.commands.set(bindParticipantRoleCommand.data.name, bindParticipantRoleCommand);
client.commands.set(manageParticipantRoleCommand.data.name, manageParticipantRoleCommand);
client.commands.set(setExternalSubmissionOptInCommand.data.name, setExternalSubmissionOptInCommand);
client.commands.set(viewSubmissionsCommand.data.name, viewSubmissionsCommand);
client.commands.set(viewSubmissionsContextCommand.data.name, viewSubmissionsContextCommand);

// 自动清理系统命令
client.commands.set(addBannedKeywordCommand.data.name, addBannedKeywordCommand);
client.commands.set(removeBannedKeywordCommand.data.name, removeBannedKeywordCommand);
client.commands.set(listBannedKeywordsCommand.data.name, listBannedKeywordsCommand);
client.commands.set(setCleanupChannelsCommand.data.name, setCleanupChannelsCommand);
client.commands.set(cleanupHistoryCommand.data.name, cleanupHistoryCommand);
client.commands.set(cleanupFullServerCommand.data.name, cleanupFullServerCommand);
client.commands.set(stopCleanupTaskCommand.data.name, stopCleanupTaskCommand);
client.commands.set(cleanupStatusCommand.data.name, cleanupStatusCommand);
client.commands.set(toggleAutoCleanupCommand.data.name, toggleAutoCleanupCommand);
// 豁免频道命令
client.commands.set(addExemptChannelCommand.data.name, addExemptChannelCommand);
client.commands.set(removeExemptChannelCommand.data.name, removeExemptChannelCommand);
client.commands.set(listExemptChannelsCommand.data.name, listExemptChannelsCommand);
client.commands.set(cleanupSelectedChannelsCommand.data.name, cleanupSelectedChannelsCommand);

// 论坛重建系统命令
client.commands.set(rebuildForumCommand.data.name, rebuildForumCommand);

// 帖子重建系统命令
client.commands.set(rebuildThreadsCommand.data.name, rebuildThreadsCommand);
client.commands.set(deleteRebuiltMessageCommand.data.name, deleteRebuiltMessageCommand);

// 补卡系统命令
client.commands.set(processBackupCardsCommand.data.name, processBackupCardsCommand);
client.commands.set(testBackupCardsCommand.data.name, testBackupCardsCommand);
client.commands.set(archiveBackupThreadsCommand.data.name, archiveBackupThreadsCommand);
client.commands.set(cleanupFuzzyMatchesCommand.data.name, cleanupFuzzyMatchesCommand);

// 频道总结系统命令
client.commands.set(summarizeChannelCommand.data.name, summarizeChannelCommand);

// 投票系统命令
client.commands.set(createVoteCommand.data.name, createVoteCommand);
// 注册新的通知身份组命令
client.commands.set(notificationRolesCommand.data.name, notificationRolesCommand);

// 选举系统命令 - 完整注册
client.commands.set(setElectionPositionsCommand.data.name, setElectionPositionsCommand);
client.commands.set(setElectionTimeScheduleCommand.data.name, setElectionTimeScheduleCommand);
client.commands.set(setupElectionEntryCommand.data.name, setupElectionEntryCommand);
client.commands.set(getElectionStatusCommand.data.name, getElectionStatusCommand);
client.commands.set(setRegistrationRolesCommand.data.name, setRegistrationRolesCommand);
client.commands.set(setVotingRolesCommand.data.name, setVotingRolesCommand);
client.commands.set(setNotificationRolesCommand.data.name, setNotificationRolesCommand);
client.commands.set(getTieAnalysisCommand.data.name, getTieAnalysisCommand);
client.commands.set(reprocessElectionResultsCommand.data.name, reprocessElectionResultsCommand);
client.commands.set(viewCandidateInfoCommand.data.name, viewCandidateInfoCommand);
client.commands.set(manageCandidateStatusCommand.data.name, manageCandidateStatusCommand);
client.commands.set(scanCandidateMessagesCommand.data.name, scanCandidateMessagesCommand);
client.commands.set(editCandidateInfoCommand.data.name, editCandidateInfoCommand);
client.commands.set(clearElectionVoteCommand.data.name, clearElectionVoteCommand);
client.commands.set(viewVoteRemovalLogsCommand.data.name, viewVoteRemovalLogsCommand);
client.commands.set(updateVotingCandidatesCommand.data.name, updateVotingCandidatesCommand);

// 自助文件上传系统命令
client.commands.set(uploadCommand.data.name, uploadCommand);
client.commands.set(whoisCommand.data.name, whoisCommand);
client.commands.set(manageOptOutCommand.data.name, manageOptOutCommand);
client.commands.set(collectBackupsCommand.data.name, collectBackupsCommand);

//// 自助身份组系统命令
client.commands.set(setupRolePanelCommand.data.name, setupRolePanelCommand);
client.commands.set(setupAdminPanelCommand.data.name, setupAdminPanelCommand);
client.commands.set(recalculateActivityCommand.data.name, recalculateActivityCommand);
client.commands.set(checkActivityCommand.data.name, checkActivityCommand);
client.commands.set(debugRolesCommand.data.name, debugRolesCommand); // 调试命令
client.commands.set(clearCooldownCommand.data.name, clearCooldownCommand);
client.commands.set(configureRolesCommand.data.name, configureRolesCommand);
client.commands.set(roleSyncConfigCommand.data.name, roleSyncConfigCommand);

// 处罚系统命令
client.commands.set(punishCommand.data.name, punishCommand);

// 分服受控邀请系统命令
client.commands.set(controlledInviteConfigCommand.data.name, controlledInviteConfigCommand);

client.once(Events.ClientReady, async (readyClient) => {
    await clientReadyHandler(readyClient);
    printTimeConfig();
    
    startProposalChecker(readyClient);
    console.log('✅ 提案检查器已启动');
    
    startCourtChecker(readyClient);
    console.log('✅ 法庭系统检查器已启动');
    
    startSelfModerationChecker(readyClient);
    console.log('✅ 自助管理检查器已启动');
    
    startAttachmentCleanupScheduler(readyClient);
    console.log('✅ 附件清理定时器已启动');
    
    startVoteChecker(readyClient);
    console.log('✅ 投票检查器已启动');
    
    startElectionScheduler(readyClient);
    console.log('✅ 选举调度器已启动');
    
    // 初始化自动清理系统
    console.log('✅ 自动清理系统已启动');

    startActivityTracker();
    
    // 在机器人完全启动前，执行离线数据同步
    await syncMissedActivity(readyClient);

    // 启动身份组同步系统
    await startRoleSyncSystem(readyClient);

    // 启动处罚系统
    await startPunishmentSystem(readyClient);

    // 启动分服受控邀请系统
    await startControlledInviteSystem(readyClient);

    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
    console.log('🏆 赛事管理系统已加载');
    console.log('🧹 自动消息清理系统已加载');
    console.log('🗳️ 选举系统已完全加载 (包含16个命令)');
    console.log('🎴 补卡管理系统已加载 (包含3个命令)');
})

client.on(Events.InteractionCreate, interactionCreateHandler)

// 添加消息创建事件处理器
client.on(Events.MessageCreate, messageCreateHandler);
client.on(Events.GuildMemberAdd, roleSyncGuildMemberAddHandler);
client.on(Events.GuildMemberAdd, controlledInviteGuildMemberAddHandler);
client.on(Events.GuildMemberRemove, roleSyncGuildMemberRemoveHandler);
client.on(Events.GuildMemberUpdate, roleSyncGuildMemberUpdateHandler);
client.on(Events.GuildRoleDelete, roleSyncGuildRoleDeleteHandler);

client.login(process.env.DISCORD_TOKEN);