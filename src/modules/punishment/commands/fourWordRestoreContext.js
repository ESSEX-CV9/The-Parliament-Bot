const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { restore } = require('../services/fourWordService');

const data = new ContextMenuCommandBuilder().setName('四字恢复').setType(ApplicationCommandType.User);

module.exports = { data, execute: restore };
