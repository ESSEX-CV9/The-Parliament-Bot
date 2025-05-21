require('dotenv').config();

const  {
    Client,
    Collection,
    Events, 
    GatewayIntentBits,
} = require('discord.js')

const { clientReadyHandler } = require('./events/clientReady')

const pingCommand = require('./commands/ping')

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
    ]
});

client.commands = new Collection();

client.commands.set(pingCommand.data.name, pingCommand);

client.on(Events.ClientReady,clientReadyHandler);

client.login(process.env.DISCORD_TOKEN);