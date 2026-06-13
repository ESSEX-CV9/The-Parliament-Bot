// src/modules/contest/commands/syncTournament.js
const { SlashCommandBuilder, ChannelType, MessageFlags, EmbedBuilder } = require('discord.js');
const { getContestSettings } = require('../utils/contestDatabase');
const { checkContestReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/contestPermissions');
const { retroSync } = require('../services/tournamentSyncService');

const data = new SlashCommandBuilder()
    .setName('赛事-同步书单')
    .setDescription('将赛事书单同步到索引页，补全历史投稿记录')
    .addChannelOption(option =>
        option.setName('频道')
            .setDescription('指定要同步的赛事频道（不填则同步全部赛事）')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText));

// 进度更新最小间隔（毫秒），避免频繁编辑消息触发 Discord 限流
const EDIT_THROTTLE_MS = 2500;

// 生成进度条
function progressBar(processed, total, width = 18) {
    if (!total) return '▱'.repeat(width);
    const filled = Math.min(width, Math.round((processed / total) * width));
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// 构建进度 Embed
function buildEmbed({ scopeText, triggerTag, p, done, error }) {
    const processed = p?.processed ?? 0;
    const total = p?.total ?? 0;
    const pct = total ? Math.round((processed / total) * 100) : 0;

    const embed = new EmbedBuilder()
        .setTitle('📚 赛事书单同步')
        .setColor(error ? 0xED4245 : done ? 0x57F287 : 0xFEE75C);

    const lines = [
        `**范围：** ${scopeText}`,
        `**发起人：** ${triggerTag}`,
        '',
        `${progressBar(processed, total)}  **${processed}/${total}** 场（${pct}%）`,
        `➕ 新增投稿：**${p?.addedItems ?? 0}** 条`,
        `⏭️ 跳过帖子：**${p?.skippedItems ?? 0}** 条`,
    ];
    if (p?.errorCount) lines.push(`⚠️ 失败赛事：**${p.errorCount}** 场`);

    if (error) {
        lines.unshift('❌ **同步出错，已中断**\n');
    } else if (done) {
        lines.unshift('✅ **同步完成**\n');
    } else {
        lines.unshift('🔄 **正在同步…**\n');
        if (p?.currentTitle) lines.push(`\n*当前：${p.currentTitle}*`);
    }

    embed.setDescription(lines.join('\n'));
    return embed;
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

        const targetChannel = interaction.options.getChannel('频道');
        const targetChannelId = targetChannel?.id || null;
        const scopeText = targetChannel ? `<#${targetChannelId}>` : '全部赛事';
        const triggerTag = `<@${interaction.user.id}>`;

        // 先给发起人一个私密确认（不阻塞、不怕超时），真正的进度看频道公开消息
        await interaction.reply({
            content: `✅ 已开始同步 ${scopeText} 的书单，进度见本频道的同步消息。`,
            flags: MessageFlags.Ephemeral,
        });

        // 频道里发一条公开进度消息（普通消息，编辑不受 interaction token 生命周期影响）
        let progressMsg = null;
        try {
            progressMsg = await interaction.channel.send({
                embeds: [buildEmbed({ scopeText, triggerTag, p: { processed: 0, total: 0 } })],
            });
        } catch (e) {
            // 没有发言权限等情况：退回到私密结果汇报
            console.warn('[syncTournament] 无法在频道发进度消息，改用私密回复:', e.message);
        }

        // 节流的进度更新器
        let lastEdit = 0;
        let latest = null;
        let editing = false;
        let finalizing = false; // 进入收尾后不再让中途进度覆盖最终结果
        const flushEdit = async (force = false) => {
            if (!progressMsg || !latest || finalizing) return;
            const now = Date.now();
            if (!force && (editing || now - lastEdit < EDIT_THROTTLE_MS)) return;
            editing = true;
            lastEdit = now;
            try {
                await progressMsg.edit({ embeds: [buildEmbed({ scopeText, triggerTag, p: latest })] });
            } catch (e) {
                console.warn('[syncTournament] 更新进度消息失败:', e.message);
            } finally {
                editing = false;
            }
        };

        const onProgress = (p) => {
            latest = p;
            flushEdit(false); // 节流，非阻塞
        };

        // 执行同步
        const stats = await retroSync(interaction.guild.id, targetChannelId, onProgress);
        finalizing = true; // 停止中途进度编辑，确保最终结果不被覆盖

        // 最终结果
        const finalProgress = {
            processed: stats.synced + stats.errors.length,
            total: stats.total,
            addedItems: stats.addedItems,
            skippedItems: stats.skippedItems,
            errorCount: stats.errors.length,
        };

        const errorDetail = stats.errors.length > 0
            ? '\n\n⚠️ **失败赛事：**\n' + stats.errors.slice(0, 10).map(e => `• ${e.title}：${e.error}`).join('\n') +
              (stats.errors.length > 10 ? `\n…等共 ${stats.errors.length} 场` : '')
            : '';
        const excludedNote = stats.excluded ? `\n🚫 跳过排除名单中的 **${stats.excluded}** 场` : '';

        if (progressMsg) {
            const embed = buildEmbed({ scopeText, triggerTag, p: finalProgress, done: true });
            if (errorDetail || excludedNote) {
                embed.addFields({ name: '备注', value: (excludedNote + errorDetail).trim().slice(0, 1024) || '—' });
            }
            await progressMsg.edit({ embeds: [embed] }).catch(() => {});
            await interaction.editReply({ content: `✅ ${scopeText} 同步完成，详情见频道消息。` }).catch(() => {});
        } else {
            // 频道消息发送失败时的私密兜底
            await interaction.editReply({
                content:
                    `✅ **书单同步完成**\n\n` +
                    `📦 共处理 **${stats.total}** 场赛事\n` +
                    `✔️ 成功同步 **${stats.synced}** 场\n` +
                    `➕ 新增投稿 **${stats.addedItems}** 条\n` +
                    `⏭️ 跳过 **${stats.skippedItems}** 条` +
                    excludedNote + errorDetail,
            }).catch(() => {});
        }

    } catch (error) {
        console.error('[syncTournament] 执行出错:', error);
        try {
            await interaction.editReply({ content: `❌ 同步时出现错误：${error.message}` });
        } catch (_) {
            try {
                await interaction.followUp({ content: `❌ 同步时出现错误：${error.message}`, flags: MessageFlags.Ephemeral });
            } catch (_) {}
        }
    }
}

module.exports = { data, execute };
