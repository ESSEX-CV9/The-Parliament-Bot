const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const runtimeConfig = require('../utils/runtimeConfig');

// ========== 命令定义 ==========

const data = new SlashCommandBuilder()
    .setName('受控邀请参数')
    .setDescription('查看/修改受控邀请系统的运行时调优参数')
    .setDefaultMemberPermissions(0)

    .addSubcommand(sub => sub
        .setName('查看')
        .setDescription('查看所有运行时参数的当前值和默认值')
    )
    .addSubcommand(sub => sub
        .setName('修改')
        .setDescription('修改指定运行时参数')
        .addStringOption(opt => opt
            .setName('参数名')
            .setDescription('要修改的参数')
            .setRequired(true)
            .addChoices(
                { name: 'globalMaxInflight — 全局同时处理上限', value: 'globalMaxInflight' },
                { name: 'subMaxInflight — 单分服同时处理上限', value: 'subMaxInflight' },
                { name: 'idempotentLockTtlMs — 幂等锁时长(ms)', value: 'idempotentLockTtlMs' },
                { name: 'reservationTtlSeconds — DB预占位超时(s)', value: 'reservationTtlSeconds' },
                { name: 'retryMaxAttempts — 邀请码重试次数', value: 'retryMaxAttempts' },
                { name: 'retryBaseDelayMs — 重试退避时长(ms)', value: 'retryBaseDelayMs' },
                { name: 'logQueueMaxPending — 日志队列最大积压', value: 'logQueueMaxPending' },
                { name: 'logQueueWarnThreshold — 日志队列告警阈值', value: 'logQueueWarnThreshold' },
                { name: 'metricsReportIntervalMs — 指标周期(ms)', value: 'metricsReportIntervalMs' },
                { name: 'alertUnknownInteractionThreshold', value: 'alertUnknownInteractionThreshold' },
                { name: 'alert429Threshold — 429告警阈值', value: 'alert429Threshold' },
                { name: 'alertErrorRatePercent — 失败率告警(%)', value: 'alertErrorRatePercent' },
                { name: 'alertP95LatencyMs — P95延迟告警(ms)', value: 'alertP95LatencyMs' },
                { name: 'alertQueuePendingThreshold — 邀请队列告警', value: 'alertQueuePendingThreshold' },
                { name: 'alertLogQueuePendingThreshold — 日志队列告警', value: 'alertLogQueuePendingThreshold' },
            )
        )
        .addIntegerOption(opt => opt
            .setName('值')
            .setDescription('新值（正整数）')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand(sub => sub
        .setName('重置')
        .setDescription('将指定参数恢复为默认值')
        .addStringOption(opt => opt
            .setName('参数名')
            .setDescription('要重置的参数')
            .setRequired(true)
            .addChoices(
                { name: 'globalMaxInflight — 全局同时处理上限', value: 'globalMaxInflight' },
                { name: 'subMaxInflight — 单分服同时处理上限', value: 'subMaxInflight' },
                { name: 'idempotentLockTtlMs — 幂等锁时长(ms)', value: 'idempotentLockTtlMs' },
                { name: 'reservationTtlSeconds — DB预占位超时(s)', value: 'reservationTtlSeconds' },
                { name: 'retryMaxAttempts — 邀请码重试次数', value: 'retryMaxAttempts' },
                { name: 'retryBaseDelayMs — 重试退避时长(ms)', value: 'retryBaseDelayMs' },
                { name: 'logQueueMaxPending — 日志队列最大积压', value: 'logQueueMaxPending' },
                { name: 'logQueueWarnThreshold — 日志队列告警阈值', value: 'logQueueWarnThreshold' },
                { name: 'metricsReportIntervalMs — 指标周期(ms)', value: 'metricsReportIntervalMs' },
                { name: 'alertUnknownInteractionThreshold', value: 'alertUnknownInteractionThreshold' },
                { name: 'alert429Threshold — 429告警阈值', value: 'alert429Threshold' },
                { name: 'alertErrorRatePercent — 失败率告警(%)', value: 'alertErrorRatePercent' },
                { name: 'alertP95LatencyMs — P95延迟告警(ms)', value: 'alertP95LatencyMs' },
                { name: 'alertQueuePendingThreshold — 邀请队列告警', value: 'alertQueuePendingThreshold' },
                { name: 'alertLogQueuePendingThreshold — 日志队列告警', value: 'alertLogQueuePendingThreshold' },
            )
        )
    );

// ========== 命令执行 ==========

async function execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    try {
        switch (sub) {
            case '查看': {
                const allParams = runtimeConfig.getAll();

                // 按 group 分组
                const groups = new Map();
                for (const p of allParams) {
                    if (!groups.has(p.group)) groups.set(p.group, []);
                    groups.get(p.group).push(p);
                }

                const lines = [];
                for (const [groupName, params] of groups) {
                    lines.push(`**📂 ${groupName}**`);
                    for (const p of params) {
                        const marker = p.isCustom ? '🔧' : '⚙️';
                        const customNote = p.isCustom ? ` *(默认: ${p.defaultValue})*` : '';
                        lines.push(`${marker} \`${p.key}\`: **${p.currentValue}**${customNote}`);
                        lines.push(`　　${p.label}`);
                    }
                    lines.push('');
                }

                const embed = new EmbedBuilder()
                    .setTitle('⚙️ 受控邀请运行时参数')
                    .setDescription(lines.join('\n'))
                    .setColor(0x5865F2)
                    .setFooter({ text: '🔧 = 已自定义 | ⚙️ = 使用默认值' })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }

            case '修改': {
                const key = interaction.options.getString('参数名');
                const value = interaction.options.getInteger('值');

                const def = runtimeConfig.getDefinition(key);
                if (!def) {
                    await interaction.editReply(`❌ 未知参数: \`${key}\``);
                    return;
                }

                const result = runtimeConfig.set(key, value);
                if (!result.ok) {
                    await interaction.editReply(`❌ 修改失败: ${result.error}`);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('✅ 参数已修改')
                    .setDescription([
                        `**参数**: \`${key}\``,
                        `**说明**: ${def.label}`,
                        `**新值**: **${value}**`,
                        `**默认值**: ${def.defaultValue}`,
                    ].join('\n'))
                    .setColor(0x57F287)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }

            case '重置': {
                const key = interaction.options.getString('参数名');

                const def = runtimeConfig.getDefinition(key);
                if (!def) {
                    await interaction.editReply(`❌ 未知参数: \`${key}\``);
                    return;
                }

                const result = runtimeConfig.reset(key);
                if (!result.ok) {
                    await interaction.editReply(`❌ 重置失败: ${result.error}`);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('🔄 参数已重置')
                    .setDescription([
                        `**参数**: \`${key}\``,
                        `**说明**: ${def.label}`,
                        `**已恢复为默认值**: **${result.defaultValue}**`,
                    ].join('\n'))
                    .setColor(0xFEE75C)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }
        }
    } catch (err) {
        console.error('[ControlledInvite][Params] 命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
