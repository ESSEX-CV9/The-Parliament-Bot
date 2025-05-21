const { SlashCommandBuilder} = require('discord.js');

const data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('This sent back with a Pong!');

async function execute(interaction) {
    await interaction.reply('Pong!');
}

module.exports = {
    data,
    execute,
};