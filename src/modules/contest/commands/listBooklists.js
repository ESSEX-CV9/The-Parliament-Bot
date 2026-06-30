// src/modules/contest/commands/listBooklists.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestSettings } = require('../utils/contestDatabase');
const { checkContestReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/contestPermissions');
const { listGuildBooklists } = require('../services/tournamentSyncService');

const data = new SlashCommandBuilder()
    .setName('赛事-书单列表')
    .setDescription('查看索引页上本服全部赛事书单（名称、帖子数、频道是否存在），便于排查孤儿书单');

// 检测频道是否仍存在（孤儿书单的频道已被删除）
async function channelExists(guild, channelId) {
    try {
        const ch = await guild.channels.fetch(channelId);
        return !!ch;
    } catch (_) {
        return false;
    }
}

async function execute(interaction) {
    try {
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用。',
                flags: MessageFlags.Ephemeral,
            });
        }

        const settings = await getContestSettings(interaction.guild.id);
        if (!checkContestReviewPermission(interaction.member, settings)) {
            return interaction.reply({
                content: getReviewPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const booklists = await listGuildBooklists(interaction.guild.id);
        if (booklists.length === 0) {
            return interaction.editReply({ content: 'ℹ️ 本服在索引页上暂无任何赛事书单。' });
        }

        // 逐个检测频道是否还在
        const rows = [];
        let orphanCount = 0;
        for (const bl of booklists) {
            const exists = await channelExists(interaction.guild, bl.channelId);
            if (!exists) orphanCount++;
            const flags = [];
            if (!exists) flags.push('⚠️频道已删除');
            if (bl.isExcluded) flags.push('🚫已排除');
            const flagText = flags.length ? `  ${flags.join(' / ')}` : '';
            rows.push(`• **${bl.title}** — ${bl.itemCount} 帖${flagText}\n　└ 频道ID: \`${bl.channelId}\``);
        }

        const header =
            `📚 **本服赛事书单（共 ${booklists.length} 个${orphanCount ? `，其中 ${orphanCount} 个疑似孤儿` : ''}）**\n` +
            (orphanCount
                ? `\n⚠️ 标记「频道已删除」的是孤儿书单：原频道已不存在。可用 \`/赛事-同步排除\` 加入排除名单（避免同步时被重建），再用 \`/赛事-删除书单\` 按频道ID删除。\n`
                : '') +
            '\n';

        // 分块发送，避免超出 2000 字限制
        const chunks = [];
        let buf = header;
        for (const row of rows) {
            if ((buf + row + '\n\n').length > 1900) {
                chunks.push(buf);
                buf = '';
            }
            buf += row + '\n\n';
        }
        if (buf.trim()) chunks.push(buf);

        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
        }

    } catch (error) {
        console.error('[listBooklists] 执行出错:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ 获取书单列表时出错：${error.message}` });
            } else {
                await interaction.reply({ content: `❌ 获取书单列表时出错：${error.message}`, flags: MessageFlags.Ephemeral });
            }
        } catch (_) {}
    }
}

module.exports = { data, execute };
