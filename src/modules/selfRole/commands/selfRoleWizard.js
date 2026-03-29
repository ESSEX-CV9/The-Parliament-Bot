// src/modules/selfRole/commands/selfRoleWizard.js

const { SlashCommandBuilder } = require('discord.js');

const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { startSelfRoleConfigWizard } = require('../services/configWizardService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('自助身份组申请-配置向导')
    .setDescription('用多步交互向导一次性完成某身份组的自助申请配置')
    .setDMPermission(false)
    .addRoleOption((opt) =>
      opt
        .setName('目标身份组')
        .setDescription('要配置的身份组')
        .setRequired(true),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
      await interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await startSelfRoleConfigWizard(interaction);
  },
};
