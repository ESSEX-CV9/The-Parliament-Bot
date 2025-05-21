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

const pingCommand = require('./commands/ping');
const setupFormCommand = require('./commands/setupForm');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
    ]
});

client.commands = new Collection();

client.commands.set(pingCommand.data.name, pingCommand);

client.commands.set(setupFormCommand.data.name, setupFormCommand);

client.once(Events.ClientReady,clientReadyHandler); // only tragger once

client.on(Events.InteractionCreate, interactionCreateHandler)

client.login(process.env.DISCORD_TOKEN);