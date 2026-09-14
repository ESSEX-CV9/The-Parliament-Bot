const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { openPunishModal } = require('../services/fourWordService');

const data = new ContextMenuCommandBuilder().setName('四字处罚').setType(ApplicationCommandType.User);

module.exports = { data, execute: openPunishModal };
