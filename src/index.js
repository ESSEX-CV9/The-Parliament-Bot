// src/index.js - 主入口文件

require('dotenv').config();

const  {
    Client,
    Collection,
    Events, 
    GatewayIntentBits,
} = require('discord.js')

const { clientReadyHandler } = require('./events/clientReady')
const { interactionCreateHandler } = require('./events/interactionCreate')
const { startProposalChecker } = require('./services/proposalChecker');
const { startCourtChecker } = require('./services/courtChecker');
const { printTimeConfig } = require('./config/timeconfig');

const pingCommand = require('./commands/ping');
const setupFormCommand = require('./commands/setupForm');
const deleteEntryCommand = require('./commands/deleteEntry');
const withdrawProposalCommand = require('./commands/withdrawProposal');
const setCheckChannelCommand = require('./commands/setCheckChannel');
const setupReviewCommand = require('./commands/setupReview');
const addAllowPreviewServerCommand = require('./commands/addAllowPreviewServer');
const removeAllowPreviewServerCommand = require('./commands/removeAllowPreviewServer');
const deleteReviewEntryCommand = require('./commands/deleteReviewEntry');
const addAllowedForumCommand = require('./commands/addAllowedForum'); 
const removeAllowedForumCommand = require('./commands/removeAllowedForum');
// 法庭相关命令
const setAllowCourtRoleCommand = require('./commands/setAllowCourtRole');
const applyToCourtCommand = require('./commands/applyToCourt');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
    ]
});

client.commands = new Collection();

// 注册所有命令
client.commands.set(pingCommand.data.name, pingCommand);
client.commands.set(setupFormCommand.data.name, setupFormCommand);
client.commands.set(deleteEntryCommand.data.name, deleteEntryCommand);
client.commands.set(withdrawProposalCommand.data.name, withdrawProposalCommand);
client.commands.set(setCheckChannelCommand.data.name, setCheckChannelCommand);
client.commands.set(setupReviewCommand.data.name, setupReviewCommand);
client.commands.set(addAllowPreviewServerCommand.data.name, addAllowPreviewServerCommand);
client.commands.set(removeAllowPreviewServerCommand.data.name, removeAllowPreviewServerCommand);
client.commands.set(deleteReviewEntryCommand.data.name, deleteReviewEntryCommand);
client.commands.set(addAllowedForumCommand.data.name, addAllowedForumCommand);
client.commands.set(removeAllowedForumCommand.data.name, removeAllowedForumCommand);
client.commands.set(setAllowCourtRoleCommand.data.name, setAllowCourtRoleCommand);
client.commands.set(applyToCourtCommand.data.name, applyToCourtCommand);

client.once(Events.ClientReady, async (readyClient) => {
    // 调用ready处理程序
    await clientReadyHandler(readyClient);
    
    // 打印时间配置
    printTimeConfig();
    
    // 启动提案检查器
    startProposalChecker(readyClient);
    console.log('✅ 提案检查器已启动');
    
    // 启动法庭检查器
    startCourtChecker(readyClient);
    console.log('✅ 法庭系统检查器已启动');
    
    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
})

client.on(Events.InteractionCreate, interactionCreateHandler)

client.login(process.env.DISCORD_TOKEN);