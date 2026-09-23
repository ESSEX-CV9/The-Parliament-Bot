const { SlashCommandBuilder } = require('discord.js');
const { punish, restore } = require('../services/fourWordService');

const data = new SlashCommandBuilder().setName('四字').setDescription('四字处罚与身份组恢复')
    .addSubcommand(sub => sub.setName('处罚').setDescription('对成员执行四字处罚')
        .addUserOption(opt => opt.setName('成员').setDescription('处罚对象').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('处罚原因').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('恢复').setDescription('恢复成员的四字身份组')
        .addUserOption(opt => opt.setName('成员').setDescription('恢复对象').setRequired(true)));

async function execute(interaction) {
    const targetId = interaction.options.getUser('成员').id;
    if (interaction.options.getSubcommand() === '处罚') {
        return punish(interaction, targetId, interaction.options.getString('原因')?.trim() || null);
    }
    return restore(interaction, targetId);
}

module.exports = { data, execute };
