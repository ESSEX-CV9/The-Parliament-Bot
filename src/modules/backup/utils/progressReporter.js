const { EmbedBuilder } = require('discord.js');
const config = require('../config');

class ProgressReporter {
  constructor(user) {
    this.user = user;
    this.lastUpdate = 0;
    this.dmMessage = null;
    this.data = {
      phase: '初始化',
      totalChannels: 0,
      processedChannels: 0,
      totalMessages: 0,
      totalAttachments: 0,
      errors: [],
    };
  }

  buildEmbed() {
    const { phase, totalChannels, processedChannels, totalMessages, totalAttachments, errors } = this.data;
    const embed = new EmbedBuilder()
      .setTitle('📦 备份进行中')
      .setColor(0x5865f2)
      .addFields(
        { name: '阶段', value: phase, inline: true },
        { name: '频道进度', value: `${processedChannels} / ${totalChannels}`, inline: true },
        { name: '消息数', value: `${totalMessages}`, inline: true },
        { name: '附件数', value: `${totalAttachments}`, inline: true },
      )
      .setTimestamp();

    if (errors.length > 0) {
      const errorText = errors.slice(-5).map(e => `• ${e}`).join('\n');
      embed.addFields({ name: `⚠️ 错误 (${errors.length})`, value: errorText });
    }
    return embed;
  }

  async init() {
    try {
      const dm = await this.user.createDM();
      const embed = this.buildEmbed();
      this.dmMessage = await dm.send({ embeds: [embed] });
    } catch {
      this.dmMessage = null;
    }
  }

  async update(partial) {
    Object.assign(this.data, partial);
    const now = Date.now();
    if (now - this.lastUpdate < config.progressUpdateInterval) return;
    this.lastUpdate = now;

    if (!this.dmMessage) return;
    const embed = this.buildEmbed();
    try {
      await this.dmMessage.edit({ embeds: [embed] });
    } catch {
      const dm = await this.user.createDM().catch(() => null);
      if (dm) this.dmMessage = await dm.send({ embeds: [embed] }).catch(() => null);
    }
  }

  async complete(summary) {
    const embed = new EmbedBuilder()
      .setTitle('✅ 备份完成')
      .setColor(0x57f287)
      .addFields(
        { name: '频道数', value: `${summary.channels}`, inline: true },
        { name: '消息数', value: `${summary.messages}`, inline: true },
        { name: '附件数', value: `${summary.attachments}`, inline: true },
        { name: '耗时', value: summary.duration, inline: true },
      )
      .setTimestamp();

    if (summary.errors > 0) {
      embed.addFields({ name: '⚠️ 错误数', value: `${summary.errors}`, inline: true });
    }

    await this.sendEmbed(embed);
  }

  async fail(errorMessage) {
    const embed = new EmbedBuilder()
      .setTitle('❌ 备份失败')
      .setColor(0xed4245)
      .setDescription(errorMessage)
      .setTimestamp();

    await this.sendEmbed(embed);
  }

  async sendEmbed(embed) {
    try {
      if (this.dmMessage) {
        await this.dmMessage.edit({ embeds: [embed] });
      } else {
        const dm = await this.user.createDM();
        this.dmMessage = await dm.send({ embeds: [embed] });
      }
    } catch {
      const dm = await this.user.createDM().catch(() => null);
      if (dm) await dm.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

module.exports = { ProgressReporter };
