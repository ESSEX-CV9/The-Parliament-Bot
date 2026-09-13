const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");

const data = new SlashCommandBuilder()
  .setName("呼叫所有人")
  .setDescription("在当前频道呼叫所有人参与讨论")
  .setDMPermission(false)
  .addStringOption(o => o.setName("原因").setDescription("讨论呼叫的原因").setMaxLength(1024));

const permissionError = '❌ 呼叫失败，请检查机器人是否拥有“提及 @everyone、@here 和所有身份组”的权限。';

async function execute(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: "❌ 请在服务器中使用此命令。", flags: MessageFlags.Ephemeral });
  }
  // Discord 可能接受消息但不触发提及；必须预先检查机器人的频道有效权限。
  if (!interaction.appPermissions?.has(PermissionFlagsBits.MentionEveryone)) {
    return interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const reason = interaction.options.getString("原因");
    const fields = [];
    if (reason) fields.push({ name: "原因", value: reason });
    fields.push({ name: "发起人", value: `<@${interaction.user.id}>` });
    await interaction.channel.send({
      content: "@everyone",
      embeds: [{ color: 0x3498db, title: "📢 讨论呼叫", fields }],
      allowedMentions: { parse: ["everyone", "users"] },
    });
  } catch (error) {
    return interaction.editReply({ content: error.code === 50013 ? permissionError : "❌ 呼叫失败，请检查机器人能否在当前频道发送消息和嵌入链接后重试。" });
  }
  return interaction.editReply({ content: "✅ 已呼叫所有人。" });
}

module.exports = { data, execute };
