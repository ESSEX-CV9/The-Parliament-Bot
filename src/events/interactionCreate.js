// src/events/interactionCreate.js

async function interactionCreateHandler(interaction){
    const command = interaction.client.commands.get(interaction.commandName);

    await command.execute(interaction);
}

module.exports = {
    interactionCreateHandler,
}