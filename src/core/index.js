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
const { printTimeConfig } = require('./config/timeconfig');

// 导入命令
const pingCommand = require('../shared/commands/ping');
// const debugPermissionsCommand = require('../shared/commands/debugPermissions');  // 需要使用再取消注释
const setCheckChannelCommand = require('../shared/commands/setCheckChannel');

// 提案系统命令
const setupFormCommand = require('../modules/proposal/commands/setupForm');
const deleteEntryCommand = require('../modules/proposal/commands/deleteEntry');
const withdrawProposalCommand = require('../modules/proposal/commands/withdrawProposal');

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

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
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

client.once(Events.ClientReady, async (readyClient) => {
    await clientReadyHandler(readyClient);
    printTimeConfig();
    
    startProposalChecker(readyClient);
    console.log('✅ 提案检查器已启动');
    
    startCourtChecker(readyClient);
    console.log('✅ 法庭系统检查器已启动');
    
    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
})

client.on(Events.InteractionCreate, interactionCreateHandler)
client.login(process.env.DISCORD_TOKEN);