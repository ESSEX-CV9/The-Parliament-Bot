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

const pingCommand = require('./commands/ping');
const setupFormCommand = require('./commands/setupForm');
const deleteEntryCommand = require('./commands/deleteEntry');
const withdrawProposalCommand = require('./commands/withdrawProposal');
const setCheckChannelCommand = require('./commands/setCheckChannel');
const setupReviewCommand = require('./commands/setupReview');
const addAllowPreviewServerCommand = require('./commands/addAllowPreviewServer'); 
const removeAllowPreviewServerCommand = require('./commands/removeAllowPreviewServer'); 

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
    ]
});

client.commands = new Collection();

client.commands.set(pingCommand.data.name, pingCommand);
client.commands.set(setupFormCommand.data.name, setupFormCommand);
client.commands.set(deleteEntryCommand.data.name, deleteEntryCommand);
client.commands.set(withdrawProposalCommand.data.name, withdrawProposalCommand);
client.commands.set(setCheckChannelCommand.data.name, setCheckChannelCommand);
client.commands.set(setupReviewCommand.data.name, setupReviewCommand);
client.commands.set(addAllowPreviewServerCommand.data.name, addAllowPreviewServerCommand); 
client.commands.set(removeAllowPreviewServerCommand.data.name, removeAllowPreviewServerCommand); 

client.once(Events.ClientReady, async (readyClient) => {
    // 调用ready处理程序
    await clientReadyHandler(readyClient);
    
    // 启动提案检查器
    startProposalChecker(readyClient);
    
    console.log('提案检查器已启动');
})

client.on(Events.InteractionCreate, interactionCreateHandler)

client.login(process.env.DISCORD_TOKEN);