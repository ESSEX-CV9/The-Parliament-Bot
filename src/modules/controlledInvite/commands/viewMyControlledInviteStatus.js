const { SlashCommandBuilder } = require('discord.js');
const { executeMyStatus } = require('./controlledInviteConfig');

const data = new SlashCommandBuilder()
    .setName('查看我的分服受控邀请状态')
    .setDescription('查看你的受控邀请状态（冷却、黑名单、活跃邀请码）')
    .setDefaultMemberPermissions(0);

async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        await executeMyStatus(interaction);
    } catch (err) {
        console.error('[ControlledInvite] 独立状态命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
