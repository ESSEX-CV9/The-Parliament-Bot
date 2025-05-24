// src/core/events/clientReady.js

const { 
    REST, 
    Routes, 
} = require('discord.js');

const rest = new REST({ version: '10'}).setToken(process.env.DISCORD_TOKEN);

async function clientReadyHandler(client){
    console.log(`Logged in as ${client.user.tag}`);

    try{
        console.log(`Start refreshing ${client.commands.size} commands!`)

        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            {
                body: client.commands.map((command) =>{
                    return command.data.toJSON();
                })
            }
        );

        console.log(`Succsessfully reloaded ${client.commands.size} commands!`)
    } catch(error){
        console.error(error);
    }
    
}

module.exports = {
    clientReadyHandler,
}