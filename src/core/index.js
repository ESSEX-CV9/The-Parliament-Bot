// src/core/index.js
require('dotenv').config();

// --- 进程级兜底日志（避免“Discord 无响应但控制台无日志”难以排查） ---
// 可选：设置 FATAL_EXIT_ON_EXCEPTION=true，在发生 uncaughtException 时直接退出（建议配合进程守护工具使用）。
const FATAL_EXIT_ON_EXCEPTION = String(process.env.FATAL_EXIT_ON_EXCEPTION || '').toLowerCase() === 'true';

process.on('unhandledRejection', (reason) => {
    console.error('❌ [Process] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ [Process] uncaughtException:', err);
    if (FATAL_EXIT_ON_EXCEPTION) {
        process.exit(1);
    }
});

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
const { printTimeConfig } = require('./config/timeconfig');
const { startActivityTracker } = require('../modules/selfRole/services/activityTracker');
const { syncMissedActivity } = require('../modules/selfRole/services/autoSyncService');
const { startSelfRoleApplicationChecker } = require('../modules/selfRole/services/applicationChecker');
const { startSelfRoleLifecycleScheduler } = require('../modules/selfRole/services/lifecycleScheduler');
const { startSelfRoleConsistencyChecker } = require('../modules/selfRole/services/consistencyChecker');

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

// 审核系统命令（已合并为 /创作者审核）
const creatorReviewCommand = require('../modules/creatorReview/commands/creatorReview');

// 法庭系统命令
const setAllowCourtRoleCommand = require('../modules/court/commands/setAllowCourtRole');
const applyToCourtCommand = require('../modules/court/commands/applyToCourt');

// 自助管理系统命令
const deleteShitMessageCommand = require('../modules/selfModeration/commands/deleteShitMessage');
const muteShitUserCommand = require('../modules/selfModeration/commands/muteShitUser');
const seriousMuteCommand = require('../modules/selfModeration/commands/seriousMute');
// 8 个配置指令已合并为 /搬石公投配置
const selfModerationConfigCommand = require('../modules/selfModeration/commands/selfModerationConfig');
const checkMyCooldownCommand = require('../modules/selfModeration/commands/checkMyCooldown');
const getArchiveViewPermissionCommand = require('../modules/selfModeration/commands/getArchiveViewPermission');

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
const manageApplicationNotifyCommand = require('../modules/contest/commands/manageApplicationNotify');
const syncTournamentCommand = require('../modules/contest/commands/syncTournament');
const deleteTournamentCommand = require('../modules/contest/commands/deleteTournament');
const listBooklistsCommand = require('../modules/contest/commands/listBooklists');
const manageSyncExclusionCommand = require('../modules/contest/commands/manageSyncExclusion');

// 自动清理系统命令（合并后）
const keywordManagerCommand = require('../modules/autoCleanup/commands/keywordManager');
const exemptManagerCommand = require('../modules/autoCleanup/commands/exemptManager');
const cleanupManagerCommand = require('../modules/autoCleanup/commands/cleanupManager');

// 频道总结系统命令
const summarizeChannelCommand = require('../modules/channelSummary/commands/summarizeChannel');
const summaryPresetCommand = require('../modules/channelSummary/commands/summaryPreset');

// 投票系统命令
const createVoteCommand = require('../modules/voting/commands/createVote');
// 添加新的通知身份组命令
const notificationRolesCommand = require('../modules/voting/commands/notificationRoles');

const { messageCreateHandler } = require('./events/messageCreate');

// 自助文件上传系统命令
const uploadCommand = require('../modules/selfFileUpload/commands/uploadFile');
const whoisCommand = require('../modules/selfFileUpload/commands/queryAnonymousLog');
const manageOptOutCommand = require('../modules/selfFileUpload/commands/manageOptOut.js');
const collectBackupsCommand = require('../modules/selfFileUpload/commands/collectBackups.js');

//// 自助身份组系统命令
const setupRolePanelCommand = require('../modules/selfRole/commands/setupRolePanel');
const setupAdminPanelCommand = require('../modules/selfRole/commands/setupAdminPanel');
const recalculateActivityCommand = require('../modules/selfRole/commands/recalculateActivity');
const checkActivityCommand = require('../modules/selfRole/commands/checkActivity');
const debugRolesCommand = require('../modules/selfRole/commands/debugRoles'); // 调试命令
const clearCooldownCommand = require('../modules/selfRole/commands/clearCooldown');
const configureRolesCommand = require('../modules/selfRole/commands/configureRoles');
const withdrawSelfRoleApplicationCommand = require('../modules/selfRole/commands/withdrawApplication');
const selfRoleOpsCommand = require('../modules/selfRole/commands/selfRoleOps');
const selfRoleWizardCommand = require('../modules/selfRole/commands/selfRoleWizard');
let selfRoleTestCommand = null;
if (String(process.env.SELF_ROLE_ENABLE_TEST_COMMANDS || '').toLowerCase() === 'true') {
    // 仅在测试环境启用（避免生产环境误注册）
    selfRoleTestCommand = require('../modules/selfRole/commands/selfRoleTest');
    console.log('[SelfRole] 🧪 SELF_ROLE_ENABLE_TEST_COMMANDS=true：已启用自助身份组测试命令注册。');
}

// 身份组同步系统命令
const roleSyncConfigCommand = require('../modules/roleSync/commands/roleSyncConfig');

// 处罚系统
const { startPunishmentSystem } = require('../modules/punishment');
const punishCommand = require('../modules/punishment/commands/punish');
const disciplineCommand = require('../modules/punishment/commands/discipline');
const disciplineConfigCommand = require('../modules/punishment/commands/disciplineConfig');

// 机器人消息管理系统（编辑 bot 已发出的常驻消息）
const { startBotMessageSystem } = require('../modules/botMessage');
const botMessageCommand = require('../modules/botMessage/commands/botMessage');
const editBotMessageContextCommand = require('../modules/botMessage/commands/editBotMessageContext');

// 分服受控邀请系统
const { startControlledInviteSystem, controlledInviteGuildMemberAddHandler } = require('../modules/controlledInvite');
const controlledInviteConfigCommand = require('../modules/controlledInvite/commands/controlledInviteConfig');
const controlledInviteParamsCommand = require('../modules/controlledInvite/commands/controlledInviteParams');
const controlledInviteToggleCommand = require('../modules/controlledInvite/commands/controlledInviteToggle');
const viewMyControlledInviteStatusCommand = require('../modules/controlledInvite/commands/viewMyControlledInviteStatus');

// Discord 安全措施（邀请暂停托管）
const { startSafetySetupSystem } = require('../modules/safetySetup');

// 神秘指令娱乐系统
const mysteryCommand = require('../modules/mystery/commands/mysteryCommand');
const manageCommand = require('../modules/mystery/commands/manageCommand');
const { mysteryGuildMemberRemoveHandler } = require('../modules/mystery/events/guildMemberRemove');
const { mysteryGuildMemberUpdateHandler } = require('../modules/mystery/events/guildMemberUpdate');
const {
    handleGuildMemberUpdate: cowardPenaltyGuildMemberUpdateHandler,
    startCowardPenaltyRestorer,
} = require('../modules/mystery/services/cowardPenalty');

const DISCORD_REST_TIMEOUT_MS = (() => {
    const n = Number(process.env.DISCORD_REST_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 15000;
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions, // 需要这个intent来监控reaction
        GatewayIntentBits.MessageContent,
    ],
    rest: {
        // REST 请求超时（ms）。避免网络异常时请求长时间挂起导致交互无响应。
        timeout: DISCORD_REST_TIMEOUT_MS,
    },
});

// --- Discord 客户端/REST 诊断日志（用于定位“无响应但无日志”） ---
client.on('error', (err) => {
    console.error('❌ [Discord] client error:', err);
});
client.on('warn', (info) => {
    console.warn('⚠️ [Discord] client warn:', info);
});
client.on('shardError', (err, shardId) => {
    console.error(`❌ [Discord] shardError shard=${shardId}:`, err);
});
client.on('shardDisconnect', (event, shardId) => {
    console.warn(`⚠️ [Discord] shardDisconnect shard=${shardId} code=${event?.code} reason=${event?.reason}`);
});
client.on('shardReconnecting', (shardId) => {
    console.warn(`⚠️ [Discord] shardReconnecting shard=${shardId}`);
});
client.on('shardResume', (shardId, replayedEvents) => {
    console.log(`✅ [Discord] shardResume shard=${shardId} replayed=${replayedEvents}`);
});

try {
    client.rest.on('rateLimited', (info) => {
        const route = info?.route || info?.path || 'unknown';
        const method = info?.method || 'unknown';
        const timeToReset = info?.timeToReset;
        console.warn(`⚠️ [Discord][REST] rateLimited ${method} ${route} resetInMs=${timeToReset}`);
    });
} catch (_) {}

const HEALTH_LOG_INTERVAL_MINUTES = Number(process.env.HEALTH_LOG_INTERVAL_MINUTES || 0);
if (Number.isFinite(HEALTH_LOG_INTERVAL_MINUTES) && HEALTH_LOG_INTERVAL_MINUTES > 0) {
    setInterval(() => {
        console.log(
            `[Health] wsStatus=${client.ws?.status} ping=${client.ws?.ping} guilds=${client.guilds?.cache?.size} mem=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
        );
    }, Math.floor(HEALTH_LOG_INTERVAL_MINUTES * 60 * 1000));
}

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

// 审核系统命令（已合并为 /创作者审核）
client.commands.set(creatorReviewCommand.data.name, creatorReviewCommand);

// 法庭系统命令
client.commands.set(setAllowCourtRoleCommand.data.name, setAllowCourtRoleCommand);
client.commands.set(applyToCourtCommand.data.name, applyToCourtCommand);

// 自助管理系统命令
client.commands.set(deleteShitMessageCommand.data.name, deleteShitMessageCommand);
client.commands.set(muteShitUserCommand.data.name, muteShitUserCommand);
client.commands.set(seriousMuteCommand.data.name, seriousMuteCommand);
client.commands.set(selfModerationConfigCommand.data.name, selfModerationConfigCommand);
client.commands.set(checkMyCooldownCommand.data.name, checkMyCooldownCommand);
client.commands.set(getArchiveViewPermissionCommand.data.name, getArchiveViewPermissionCommand);

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
client.commands.set(manageApplicationNotifyCommand.data.name, manageApplicationNotifyCommand);
client.commands.set(syncTournamentCommand.data.name, syncTournamentCommand);
client.commands.set(deleteTournamentCommand.data.name, deleteTournamentCommand);
client.commands.set(listBooklistsCommand.data.name, listBooklistsCommand);
client.commands.set(manageSyncExclusionCommand.data.name, manageSyncExclusionCommand);

// 自动清理系统命令（合并后）
client.commands.set(keywordManagerCommand.data.name, keywordManagerCommand);
client.commands.set(exemptManagerCommand.data.name, exemptManagerCommand);
client.commands.set(cleanupManagerCommand.data.name, cleanupManagerCommand);

// 频道总结系统命令
client.commands.set(summarizeChannelCommand.data.name, summarizeChannelCommand);
client.commands.set(summaryPresetCommand.data.name, summaryPresetCommand);

// 投票系统命令
client.commands.set(createVoteCommand.data.name, createVoteCommand);
// 注册新的通知身份组命令
client.commands.set(notificationRolesCommand.data.name, notificationRolesCommand);

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
client.commands.set(withdrawSelfRoleApplicationCommand.data.name, withdrawSelfRoleApplicationCommand);
client.commands.set(selfRoleOpsCommand.data.name, selfRoleOpsCommand);
client.commands.set(selfRoleWizardCommand.data.name, selfRoleWizardCommand);
if (selfRoleTestCommand) {
    client.commands.set(selfRoleTestCommand.data.name, selfRoleTestCommand);
}
client.commands.set(roleSyncConfigCommand.data.name, roleSyncConfigCommand);

// 处罚系统命令
client.commands.set(punishCommand.data.name, punishCommand);
client.commands.set(disciplineCommand.data.name, disciplineCommand);
client.commands.set(disciplineConfigCommand.data.name, disciplineConfigCommand);

// 机器人消息管理系统命令
client.commands.set(botMessageCommand.data.name, botMessageCommand);
client.commands.set(editBotMessageContextCommand.data.name, editBotMessageContextCommand);

// 分服受控邀请系统命令
client.commands.set(controlledInviteConfigCommand.data.name, controlledInviteConfigCommand);
client.commands.set(controlledInviteParamsCommand.data.name, controlledInviteParamsCommand);
client.commands.set(controlledInviteToggleCommand.data.name, controlledInviteToggleCommand);
client.commands.set(viewMyControlledInviteStatusCommand.data.name, viewMyControlledInviteStatusCommand);

// Discord 安全措施与神秘管理工具（统一为唯一 /管理）
client.commands.set(manageCommand.data.name, manageCommand);

// 神秘指令娱乐系统
client.commands.set(mysteryCommand.data.name, mysteryCommand);

// 加压轮盘测试指令：仅在 .env 里设置 MYSTERY_TEST_COMMANDS=true 时才注册，
// 避免测试用的虚拟机器人局出现在正式服务器的指令列表里。
if (String(process.env.MYSTERY_TEST_COMMANDS).toLowerCase() === 'true') {
    const pressureTestCommand = require('../modules/mystery/commands/pressureTestCommand');
    client.commands.set(pressureTestCommand.data.name, pressureTestCommand);
    console.log('🧪 加压轮盘测试指令已注册（MYSTERY_TEST_COMMANDS=true）');
}

client.once(Events.ClientReady, async (readyClient) => {
    try {
        // 启动时强制同步命令（clientReadyHandler 内部会执行 rest.put 刷新命令）
        // 若开启 STRICT_COMMAND_SYNC=true 且存在失败 guild，将直接抛错并中止启动。
        await clientReadyHandler(readyClient);
    } catch (err) {
        console.error('❌ 启动阶段命令同步失败，进程即将退出：', err);
        try {
            readyClient.destroy();
        } catch (_) {}
        process.exit(1);
        return;
    }
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
    
    // 初始化自动清理系统
    console.log('✅ 自动清理系统已启动');

    startActivityTracker();

    // 恢复未结束的「胆小鬼」昵称惩罚，避免重启后 🤡 前缀永久卡在别人名字上
    await startCowardPenaltyRestorer(readyClient);
    console.log('✅ 胆小鬼惩罚恢复完成');

    // SelfRole 申请过期检查器（预留名额释放/旧数据兼容迁移）
    startSelfRoleApplicationChecker(readyClient);
    
    // 在机器人完全启动前，执行离线数据同步
    await syncMissedActivity(readyClient);

    // SelfRole grant 生命周期调度器（周期询问/onlyWhenFull/强制清退）
    startSelfRoleLifecycleScheduler(readyClient);

    // SelfRole 一致性巡检（grant/面板/角色残留等）
    startSelfRoleConsistencyChecker(readyClient);

    // 启动身份组同步系统
    await startRoleSyncSystem(readyClient);

    // 启动处罚系统
    await startPunishmentSystem(readyClient);

    // 启动机器人消息管理系统
    await startBotMessageSystem(readyClient);

    // 启动分服受控邀请系统
    await startControlledInviteSystem(readyClient);

    // 启动 Discord 安全措施邀请暂停托管
    await startSafetySetupSystem(readyClient);

    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
    console.log('🏆 赛事管理系统已加载');
    console.log('🧹 自动消息清理系统已加载');
    console.log('📝 机器人消息管理系统已加载');
})

client.on(Events.InteractionCreate, interactionCreateHandler)

// 添加消息创建事件处理器
client.on(Events.MessageCreate, messageCreateHandler);
client.on(Events.GuildMemberAdd, roleSyncGuildMemberAddHandler);
client.on(Events.GuildMemberAdd, controlledInviteGuildMemberAddHandler);
client.on(Events.GuildMemberRemove, roleSyncGuildMemberRemoveHandler);
client.on(Events.GuildMemberUpdate, roleSyncGuildMemberUpdateHandler);
client.on(Events.GuildRoleDelete, roleSyncGuildRoleDeleteHandler);
client.on(Events.GuildMemberRemove, mysteryGuildMemberRemoveHandler);
client.on(Events.GuildMemberUpdate, mysteryGuildMemberUpdateHandler);
client.on(Events.GuildMemberUpdate, cowardPenaltyGuildMemberUpdateHandler);

function normalizeDiscordToken(raw) {
    if (!raw) return '';
    let token = String(raw).trim();
    if (!token) return '';
    // 兼容误填 "Bot <token>"
    token = token.replace(/^Bot\s+/i, '').trim();
    return token;
}

const token = normalizeDiscordToken(process.env.DISCORD_TOKEN);
if (!token || token.includes('PASTE_YOUR_DISCORD_BOT_TOKEN')) {
    console.error('❌ 缺少或未正确配置 DISCORD_TOKEN。请在项目根目录 .env 中设置 DISCORD_TOKEN=你的机器人Token 后重启。');
    process.exit(1);
}
if (token.split('.').length !== 3) {
    console.error('❌ DISCORD_TOKEN 格式异常：应为 3 段以英文点号分隔的 token。请检查是否有空格/换行/前缀 Bot 等。');
    process.exit(1);
}

// 确保后续模块（如命令同步）拿到的是清洗后的 token
process.env.DISCORD_TOKEN = token;

client.login(token).catch((err) => {
    console.error('❌ Discord 登录失败。常见原因：Token 粘贴错误 / Token 已被重置失效 / 使用了非 Bot Token。');
    console.error(err);
    process.exit(1);
});
