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
const { printTimeConfig } = require('./config/timeconfig');

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
const setSelfModerationRolesCommand = require('../modules/selfModeration/commands/setSelfModerationRoles');
const setSelfModerationChannelsCommand = require('../modules/selfModeration/commands/setSelfModerationChannels');
const setSelfModerationCooldownCommand = require('../modules/selfModeration/commands/setSelfModerationCooldown');
const setMessageTimeLimitCommand = require('../modules/selfModeration/commands/setMessageTimeLimit');
const checkMyCooldownCommand = require('../modules/selfModeration/commands/checkMyCooldown');
const setArchiveChannelCommand = require('../modules/selfModeration/commands/setArchiveChannel');
const setArchiveViewRoleCommand = require('../modules/selfModeration/commands/setArchiveViewRole');
const getArchiveViewPermissionCommand = require('../modules/selfModeration/commands/getArchiveViewPermission');
const manageAttachmentCleanupCommand = require('../modules/selfModeration/commands/manageAttachmentCleanup');

// 赛事系统命令
const setupContestApplicationCommand = require('../modules/contest/commands/setupContestApplication');
const setContestReviewersCommand = require('../modules/contest/commands/setContestReviewers');
const reviewContestApplicationCommand = require('../modules/contest/commands/reviewContestApplication');
const updateContestInfoCommand = require('../modules/contest/commands/updateContestInfo');
const updateContestTitleCommand = require('../modules/contest/commands/updateContestTitle');
const initContestTagsCommand = require('../modules/contest/commands/initContestTags');
const manageAllowedForumsCommand = require('../modules/contest/commands/manageAllowedForums');
const manageExternalServersCommand = require('../modules/contest/commands/manageExternalServers');
const cacheStats = require('../modules/contest/commands/cacheStats');
const regenerateContestMessagesCommand = require('../modules/contest/commands/regenerateContestMessages');

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

const { messageCreateHandler } = require('./events/messageCreate');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions, // 需要这个intent来监控reaction
        GatewayIntentBits.MessageContent,
    ]
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
client.commands.set(setSelfModerationRolesCommand.data.name, setSelfModerationRolesCommand);
client.commands.set(setSelfModerationChannelsCommand.data.name, setSelfModerationChannelsCommand);
client.commands.set(setSelfModerationCooldownCommand.data.name, setSelfModerationCooldownCommand);
client.commands.set(setMessageTimeLimitCommand.data.name, setMessageTimeLimitCommand);
client.commands.set(checkMyCooldownCommand.data.name, checkMyCooldownCommand);
client.commands.set(setArchiveChannelCommand.data.name, setArchiveChannelCommand);
client.commands.set(setArchiveViewRoleCommand.data.name, setArchiveViewRoleCommand);
client.commands.set(getArchiveViewPermissionCommand.data.name, getArchiveViewPermissionCommand);
client.commands.set(manageAttachmentCleanupCommand.data.name, manageAttachmentCleanupCommand);

// 赛事系统命令
client.commands.set(setupContestApplicationCommand.data.name, setupContestApplicationCommand);
client.commands.set(setContestReviewersCommand.data.name, setContestReviewersCommand);
client.commands.set(reviewContestApplicationCommand.data.name, reviewContestApplicationCommand);
client.commands.set(updateContestInfoCommand.data.name, updateContestInfoCommand);
client.commands.set(updateContestTitleCommand.data.name, updateContestTitleCommand);
client.commands.set(initContestTagsCommand.data.name, initContestTagsCommand);
client.commands.set(manageAllowedForumsCommand.data.name, manageAllowedForumsCommand);
client.commands.set(manageExternalServersCommand.data.name, manageExternalServersCommand);
client.commands.set(cacheStats.data.name, cacheStats);
client.commands.set(regenerateContestMessagesCommand.data.name, regenerateContestMessagesCommand);

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
    
    // 初始化自动清理系统
    console.log('✅ 自动清理系统已启动');
    
    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
    console.log('🏆 赛事管理系统已加载');
    console.log('�� 自动消息清理系统已加载');
})

client.on(Events.InteractionCreate, interactionCreateHandler)

// 添加消息创建事件处理器
client.on(Events.MessageCreate, messageCreateHandler);

client.login(process.env.DISCORD_TOKEN);