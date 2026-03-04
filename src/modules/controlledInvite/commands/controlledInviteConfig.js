const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const {
    bindGuilds,
    unbindGuilds,
    getConfig,
    getConfigsByMainGuild,
    setSubInviteChannel,
    setLogChannel,
    setEntryMessage,
    setInviteMaxAge,
    setCooldownSeconds,
    setEnabled,
    setBanOnUnknownJoin,
    setBlacklistOwnerOnMisuse,
    addEligibleRole,
    removeEligibleRole,
    getEligibleRoles,
    clearEligibleRoles,
    addToBlacklist,
    removeFromBlacklist,
    getBlacklistByMainGuild,
    isUserBlacklisted,
    getActiveRequestsForSubGuild,
    revokeActiveByOwnerAndSubGuild,
    revokeActiveByOwner,
    isOnCooldown,
    getActiveRequestsByOwnerAnySubGuild,
    getBlacklistEntries,
} = require('../utils/controlledInviteDatabase');

// ========== 命令定义 ==========

const data = new SlashCommandBuilder()
    .setName('分服受控邀请')
    .setDescription('分服受控邀请系统管理')
    .setDefaultMemberPermissions(0)

    // ===== 6.1 基础配置类 =====
    .addSubcommand(sub => sub
        .setName('绑定')
        .setDescription('绑定主服与分服的关系')
        .addStringOption(opt => opt.setName('主服务器id').setDescription('主服务器ID').setRequired(true))
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('解绑')
        .setDescription('解除主服与分服的绑定')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('设置邀请码频道')
        .setDescription('设置分服内用于创建邀请码的频道')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID').setRequired(true))
        .addStringOption(opt => opt.setName('频道id').setDescription('分服内的文字频道ID').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('设置日志频道')
        .setDescription('设置日志输出频道')
        .addStringOption(opt => opt.setName('频道id').setDescription('日志频道ID（留空则清除）').setRequired(false))
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则应用到所有分服）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('设置参数')
        .setDescription('设置邀请码有效时长和冷却时间')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填时需仅有一个分服）').setRequired(false))
        .addIntegerOption(opt => opt.setName('邀请有效分钟').setDescription('邀请码有效时长（分钟，默认15）').setRequired(false))
        .addIntegerOption(opt => opt.setName('冷却小时').setDescription('申请冷却时间（小时，默认3）').setRequired(false))
        .addBooleanOption(opt => opt.setName('启用').setDescription('是否启用').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('设置处罚策略')
        .setDescription('设置非法加入和码泄漏的处罚方式')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填时需仅有一个分服）').setRequired(false))
        .addBooleanOption(opt => opt.setName('陌生人加入封禁').setDescription('无记录且不在主服的加入者是否封禁（默认是）').setRequired(false))
        .addBooleanOption(opt => opt.setName('误用拉黑申请人').setDescription('码被他人使用时是否拉黑申请人（默认是）').setRequired(false))
    )

    // ===== 6.2 资格身份组类 =====
    .addSubcommand(sub => sub
        .setName('资格角色添加')
        .setDescription('添加一个主服资格身份组')
        .addRoleOption(opt => opt.setName('身份组').setDescription('主服内的身份组').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('资格角色移除')
        .setDescription('移除一个资格身份组')
        .addRoleOption(opt => opt.setName('身份组').setDescription('要移除的身份组').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('资格角色列表')
        .setDescription('查看当前资格身份组列表')
    )
    .addSubcommand(sub => sub
        .setName('资格角色清空')
        .setDescription('清空所有资格身份组')
        .addBooleanOption(opt => opt.setName('确认').setDescription('确认清空？').setRequired(true))
    )

    // ===== 6.3 入口消息类 =====
    .addSubcommand(sub => sub
        .setName('创建入口')
        .setDescription('在指定频道发送自动生成的邀请入口消息')
        .addChannelOption(opt => opt.setName('频道').setDescription('发送入口消息的频道').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('刷新入口')
        .setDescription('手动刷新入口消息内容和按钮')
    )

    // ===== 6.4 运维与风控类 =====
    .addSubcommand(sub => sub
        .setName('查看配置')
        .setDescription('查看当前受控邀请配置')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则显示全部）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('活跃邀请码')
        .setDescription('查看当前所有未过期的邀请码')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则显示全部）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('撤销邀请码')
        .setDescription('撤销指定用户的有效邀请码')
        .addUserOption(opt => opt.setName('用户').setDescription('要撤销邀请码的用户').setRequired(true))
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则撤销所有）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('黑名单添加')
        .setDescription('将用户加入黑名单')
        .addUserOption(opt => opt.setName('用户').setDescription('要拉黑的用户').setRequired(true))
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则全局拉黑）').setRequired(false))
        .addStringOption(opt => opt.setName('原因').setDescription('拉黑原因').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('黑名单移除')
        .setDescription('将用户从黑名单移除')
        .addUserOption(opt => opt.setName('用户').setDescription('要移除的用户').setRequired(true))
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则移除全部）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('黑名单列表')
        .setDescription('查看黑名单')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则显示全部）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('我的状态')
        .setDescription('查看你的受控邀请状态（冷却、黑名单、活跃邀请码）')
        .addStringOption(opt => opt.setName('分服务器id').setDescription('分服务器ID（不填则显示全部）').setRequired(false))
    );

// ========== 辅助函数 ==========

/**
 * 解析分服务器ID：如果提供了则使用，否则自动选中唯一的分服
 * @returns {object} { config, subGuildId, error }
 */
function resolveSubGuild(interaction, configs, providedSubGuildId) {
    if (providedSubGuildId) {
        const config = configs.find(c => c.sub_guild_id === providedSubGuildId);
        if (!config) {
            return { error: `❌ 未找到分服 \`${providedSubGuildId}\` 的绑定配置` };
        }
        return { config, subGuildId: providedSubGuildId };
    }
    if (configs.length === 0) {
        return { error: '❌ 当前主服没有绑定任何分服，请先使用 `/分服受控邀请 绑定`' };
    }
    if (configs.length === 1) {
        return { config: configs[0], subGuildId: configs[0].sub_guild_id };
    }
    const subList = configs.map(c => `\`${c.sub_guild_id}\``).join(', ');
    return { error: `❌ 当前主服绑定了多个分服（${subList}），请指定 \`分服务器id\` 参数` };
}

/**
 * 检查 Bot 在目标服务器的权限
 */
async function checkBotPermissions(client, guildId) {
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { ok: false, error: '无法访问该服务器，请确认 Bot 已加入' };

        const me = await guild.members.fetchMe();
        const missing = [];

        if (!me.permissions.has(PermissionFlagsBits.CreateInstantInvite)) missing.push('CreateInstantInvite');
        if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) missing.push('ManageGuild');
        if (!me.permissions.has(PermissionFlagsBits.BanMembers)) missing.push('BanMembers');
        if (!me.permissions.has(PermissionFlagsBits.KickMembers)) missing.push('KickMembers');

        if (missing.length > 0) {
            return { ok: false, error: `Bot 在该服务器缺少权限: ${missing.join(', ')}` };
        }
        return { ok: true, guild };
    } catch (err) {
        return { ok: false, error: `权限检查失败: ${err.message}` };
    }
}

/**
 * 执行“我的状态”逻辑（供子命令和独立命令复用）
 */
async function executeMyStatus(interaction) {
    const client = interaction.client;
    const mainGuildId = interaction.guild.id;
    const userId = interaction.user.id;
    const configs = getConfigsByMainGuild(mainGuildId);

    if (configs.length === 0) {
        await interaction.editReply('当前主服没有绑定任何分服');
        return;
    }

    const lines = [];

    // 黑名单状态
    const blacklistEntries = getBlacklistEntries(mainGuildId, userId);
    if (blacklistEntries.length > 0) {
        lines.push('🚫 **黑名单状态**: 已被拉黑');
        for (const e of blacklistEntries) {
            const scope = e.sub_guild_id ? `分服 \`${e.sub_guild_id}\`` : '全局';
            lines.push(`  - ${scope}${e.reason ? `: ${e.reason}` : ''}`);
        }
    } else {
        lines.push('✅ **黑名单状态**: 正常');
    }

    // 每个分服的冷却和活跃码
    for (const config of configs) {
        const subGuild = await client.guilds.fetch(config.sub_guild_id).catch(() => null);
        const subName = subGuild ? subGuild.name : config.sub_guild_id;
        lines.push(`\n**📌 分服: ${subName}**`);

        // 冷却
        const cooldownInfo = isOnCooldown(mainGuildId, config.sub_guild_id, userId);
        if (cooldownInfo.onCooldown) {
            const cdTs = Math.floor(new Date(cooldownInfo.nextAvailableAt).getTime() / 1000);
            lines.push(`  ⏳ 冷却中，可用时间: <t:${cdTs}:R>`);
        } else {
            lines.push('  ✅ 无冷却');
        }

        // 活跃邀请码
        const activeRequests = getActiveRequestsByOwnerAnySubGuild(mainGuildId, userId)
            .filter(r => r.sub_guild_id === config.sub_guild_id);
        if (activeRequests.length > 0) {
            for (const r of activeRequests) {
                const expiresTs = Math.floor(new Date(r.expires_at).getTime() / 1000);
                lines.push(`  🔗 邀请码: \`${r.invite_code}\` | 过期: <t:${expiresTs}:R>`);
            }
        } else {
            lines.push('  📭 无活跃邀请码');
        }
    }

    const embed = new EmbedBuilder()
        .setTitle('📊 我的受控邀请状态')
        .setDescription(lines.join('\n'))
        .setColor(0x5865F2)
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

// ========== 命令执行 ==========

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // "我的状态" 是普通用户可用的，不需要管理员权限
    if (sub !== '我的状态') {
        if (!checkAdminPermission(interaction.member)) {
            await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
            return;
        }
    }

    await interaction.deferReply({ ephemeral: true });

    const client = interaction.client;
    const mainGuildId = interaction.guild.id;

    try {
        switch (sub) {
            // ===== 绑定 =====
            case '绑定': {
                const mainId = interaction.options.getString('主服务器id');
                const subId = interaction.options.getString('分服务器id');

                // 检查 Bot 在分服的权限
                const permCheck = await checkBotPermissions(client, subId);
                if (!permCheck.ok) {
                    await interaction.editReply(`❌ 绑定失败: ${permCheck.error}`);
                    return;
                }

                bindGuilds(mainId, subId);
                await interaction.editReply(`✅ 已绑定主服 \`${mainId}\` ↔ 分服 \`${subId}\`（${permCheck.guild.name}）\n⚠️ 请继续设置邀请码频道和资格角色`);
                break;
            }

            // ===== 解绑 =====
            case '解绑': {
                const subId = interaction.options.getString('分服务器id');
                const result = unbindGuilds(mainGuildId, subId);
                if (result.changes > 0) {
                    await interaction.editReply(`✅ 已解除分服 \`${subId}\` 的绑定`);
                } else {
                    await interaction.editReply(`❌ 未找到分服 \`${subId}\` 的绑定记录`);
                }
                break;
            }

            // ===== 设置邀请码频道 =====
            case '设置邀请码频道': {
                const subId = interaction.options.getString('分服务器id');
                const channelId = interaction.options.getString('频道id');
                const config = getConfig(mainGuildId, subId);
                if (!config) {
                    await interaction.editReply(`❌ 未找到分服 \`${subId}\` 的绑定配置`);
                    return;
                }

                // 验证频道可访问
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel) {
                    await interaction.editReply(`❌ 无法访问频道 \`${channelId}\`，请确认频道ID正确且 Bot 有权限`);
                    return;
                }

                setSubInviteChannel(mainGuildId, subId, channelId);
                await interaction.editReply(`✅ 已设置分服 \`${subId}\` 的邀请码频道为 \`${channelId}\`（${channel.name}）`);
                break;
            }

            // ===== 设置日志频道 =====
            case '设置日志频道': {
                const channelId = interaction.options.getString('频道id') || null;
                const subId = interaction.options.getString('分服务器id');
                const configs = getConfigsByMainGuild(mainGuildId);

                if (subId) {
                    const config = configs.find(c => c.sub_guild_id === subId);
                    if (!config) {
                        await interaction.editReply(`❌ 未找到分服 \`${subId}\` 的绑定配置`);
                        return;
                    }
                    setLogChannel(mainGuildId, subId, channelId);
                    await interaction.editReply(channelId
                        ? `✅ 已设置分服 \`${subId}\` 的日志频道为 \`${channelId}\``
                        : `✅ 已清除分服 \`${subId}\` 的日志频道`);
                } else {
                    for (const c of configs) {
                        setLogChannel(mainGuildId, c.sub_guild_id, channelId);
                    }
                    await interaction.editReply(channelId
                        ? `✅ 已设置所有分服的日志频道为 \`${channelId}\``
                        : `✅ 已清除所有分服的日志频道`);
                }
                break;
            }

            // ===== 设置参数 =====
            case '设置参数': {
                const configs = getConfigsByMainGuild(mainGuildId);
                const subId = interaction.options.getString('分服务器id');
                const resolved = resolveSubGuild(interaction, configs, subId);
                if (resolved.error) {
                    await interaction.editReply(resolved.error);
                    return;
                }
                const { config } = resolved;

                const inviteMinutes = interaction.options.getInteger('邀请有效分钟');
                const cooldownHours = interaction.options.getInteger('冷却小时');
                const enabled = interaction.options.getBoolean('启用');

                const changes = [];
                if (inviteMinutes !== null) {
                    setInviteMaxAge(mainGuildId, config.sub_guild_id, inviteMinutes * 60);
                    changes.push(`邀请有效时长: ${inviteMinutes} 分钟`);
                }
                if (cooldownHours !== null) {
                    setCooldownSeconds(mainGuildId, config.sub_guild_id, cooldownHours * 3600);
                    changes.push(`冷却时间: ${cooldownHours} 小时`);
                }
                if (enabled !== null) {
                    setEnabled(mainGuildId, config.sub_guild_id, enabled);
                    changes.push(`启用状态: ${enabled ? '✅ 已启用' : '❌ 已禁用'}`);
                }

                if (changes.length === 0) {
                    await interaction.editReply('⚠️ 未提供任何参数');
                } else {
                    await interaction.editReply(`✅ 已更新分服 \`${config.sub_guild_id}\`:\n${changes.join('\n')}`);
                    // 尝试自动更新入口消息
                    await tryUpdateEntryMessage(client, mainGuildId);
                }
                break;
            }

            // ===== 设置处罚策略 =====
            case '设置处罚策略': {
                const configs = getConfigsByMainGuild(mainGuildId);
                const subId = interaction.options.getString('分服务器id');
                const resolved = resolveSubGuild(interaction, configs, subId);
                if (resolved.error) {
                    await interaction.editReply(resolved.error);
                    return;
                }
                const { config } = resolved;

                const banOnUnknown = interaction.options.getBoolean('陌生人加入封禁');
                const blacklistOnMisuse = interaction.options.getBoolean('误用拉黑申请人');

                const changes = [];
                if (banOnUnknown !== null) {
                    setBanOnUnknownJoin(mainGuildId, config.sub_guild_id, banOnUnknown);
                    changes.push(`陌生人加入封禁: ${banOnUnknown ? '是' : '否'}`);
                }
                if (blacklistOnMisuse !== null) {
                    setBlacklistOwnerOnMisuse(mainGuildId, config.sub_guild_id, blacklistOnMisuse);
                    changes.push(`误用拉黑申请人: ${blacklistOnMisuse ? '是' : '否'}`);
                }

                if (changes.length === 0) {
                    await interaction.editReply('⚠️ 未提供任何参数');
                } else {
                    await interaction.editReply(`✅ 已更新分服 \`${config.sub_guild_id}\` 处罚策略:\n${changes.join('\n')}`);
                }
                break;
            }

            // ===== 资格角色添加 =====
            case '资格角色添加': {
                const role = interaction.options.getRole('身份组');
                const result = addEligibleRole(mainGuildId, role.id);
                if (result.changes > 0) {
                    await interaction.editReply(`✅ 已添加资格身份组 <@&${role.id}>`);
                } else {
                    await interaction.editReply(`ℹ️ 身份组 <@&${role.id}> 已在资格列表中`);
                }
                break;
            }

            // ===== 资格角色移除 =====
            case '资格角色移除': {
                const role = interaction.options.getRole('身份组');
                const result = removeEligibleRole(mainGuildId, role.id);
                if (result.changes > 0) {
                    await interaction.editReply(`✅ 已移除资格身份组 <@&${role.id}>`);
                } else {
                    await interaction.editReply(`❌ 身份组 <@&${role.id}> 不在资格列表中`);
                }
                break;
            }

            // ===== 资格角色列表 =====
            case '资格角色列表': {
                const roles = getEligibleRoles(mainGuildId);
                if (roles.length === 0) {
                    await interaction.editReply('当前没有设置任何资格身份组');
                } else {
                    const roleList = roles.map(r => `• <@&${r}>`).join('\n');
                    await interaction.editReply(`**资格身份组列表（共 ${roles.length} 个）：**\n${roleList}`);
                }
                break;
            }

            // ===== 资格角色清空 =====
            case '资格角色清空': {
                const confirm = interaction.options.getBoolean('确认');
                if (!confirm) {
                    await interaction.editReply('⚠️ 操作已取消');
                    return;
                }
                const result = clearEligibleRoles(mainGuildId);
                await interaction.editReply(`✅ 已清空所有资格身份组（共移除 ${result.changes} 个）`);
                break;
            }

            // ===== 创建入口 =====
            case '创建入口': {
                const channel = interaction.options.getChannel('频道');
                const configs = getConfigsByMainGuild(mainGuildId);
                if (configs.length === 0) {
                    await interaction.editReply('❌ 当前主服没有绑定任何分服，请先使用 `/分服受控邀请 绑定`');
                    return;
                }

                const { buildEntryMessage } = require('../services/panelService');
                const { content, embeds, components } = await buildEntryMessage(client, mainGuildId, configs);

                const msg = await channel.send({ content, embeds, components });

                // 保存入口消息信息到所有配置
                for (const config of configs) {
                    setEntryMessage(mainGuildId, config.sub_guild_id, channel.id, msg.id);
                }

                await interaction.editReply(`✅ 已在 <#${channel.id}> 发送入口消息`);
                break;
            }

            // ===== 刷新入口 =====
            case '刷新入口': {
                await tryUpdateEntryMessage(client, mainGuildId);
                await interaction.editReply('✅ 已刷新入口消息');
                break;
            }

            // ===== 查看配置 =====
            case '查看配置': {
                const subId = interaction.options.getString('分服务器id');
                const configs = getConfigsByMainGuild(mainGuildId);

                if (configs.length === 0) {
                    await interaction.editReply('当前主服没有绑定任何分服');
                    return;
                }

                const targetConfigs = subId ? configs.filter(c => c.sub_guild_id === subId) : configs;
                if (targetConfigs.length === 0) {
                    await interaction.editReply(`❌ 未找到分服 \`${subId}\` 的配置`);
                    return;
                }

                const roles = getEligibleRoles(mainGuildId);
                const roleStr = roles.length > 0 ? roles.map(r => `<@&${r}>`).join(', ') : '（未设置）';

                const embeds = [];
                for (const config of targetConfigs) {
                    const subGuild = await client.guilds.fetch(config.sub_guild_id).catch(() => null);
                    const subName = subGuild ? subGuild.name : '未知';

                    const embed = new EmbedBuilder()
                        .setTitle(`📋 受控邀请配置 - ${subName}`)
                        .setColor(config.enabled ? 0x57F287 : 0xED4245)
                        .addFields(
                            { name: '主服务器', value: `\`${config.main_guild_id}\``, inline: true },
                            { name: '分服务器', value: `${subName}\n\`${config.sub_guild_id}\``, inline: true },
                            { name: '状态', value: config.enabled ? '✅ 已启用' : '❌ 已禁用', inline: true },
                            { name: '邀请码频道', value: config.sub_invite_channel_id ? `\`${config.sub_invite_channel_id}\`` : '⚠️ 未设置', inline: true },
                            { name: '日志频道', value: config.log_channel_id ? `<#${config.log_channel_id}>` : '未设置', inline: true },
                            { name: '邀请有效时长', value: `${Math.round(config.invite_max_age_seconds / 60)} 分钟`, inline: true },
                            { name: '冷却时间', value: `${Math.round(config.cooldown_seconds / 3600)} 小时`, inline: true },
                            { name: '陌生人封禁', value: config.ban_on_unknown_join ? '是' : '否', inline: true },
                            { name: '误用拉黑码主', value: config.blacklist_owner_on_misuse ? '是' : '否', inline: true },
                        )
                        .setTimestamp();

                    embeds.push(embed);
                }

                // 添加资格角色信息
                const summary = new EmbedBuilder()
                    .setTitle('🔑 资格身份组（主服通用）')
                    .setDescription(roleStr)
                    .setColor(0x5865F2);

                embeds.push(summary);

                await interaction.editReply({ embeds: embeds.slice(0, 10) });
                break;
            }

            // ===== 活跃邀请码 =====
            case '活跃邀请码': {
                const subId = interaction.options.getString('分服务器id');
                const configs = getConfigsByMainGuild(mainGuildId);
                const targetConfigs = subId ? configs.filter(c => c.sub_guild_id === subId) : configs;

                const allRequests = [];
                for (const config of targetConfigs) {
                    const requests = getActiveRequestsForSubGuild(config.sub_guild_id);
                    allRequests.push(...requests);
                }

                if (allRequests.length === 0) {
                    await interaction.editReply('当前没有活跃的邀请码');
                    return;
                }

                const lines = allRequests.map(r => {
                    const expiresTs = Math.floor(new Date(r.expires_at).getTime() / 1000);
                    const statusEmoji = r.status === 'active' ? '🟢' : '🟡';
                    return `${statusEmoji} <@${r.owner_user_id}> | \`${r.invite_code}\` | 过期: <t:${expiresTs}:R> | 状态: ${r.status}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`📋 活跃邀请码（共 ${allRequests.length} 个）`)
                    .setDescription(lines.join('\n'))
                    .setColor(0x5865F2)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }

            // ===== 撤销邀请码 =====
            case '撤销邀请码': {
                const user = interaction.options.getUser('用户');
                const subId = interaction.options.getString('分服务器id');

                let result;
                if (subId) {
                    result = revokeActiveByOwnerAndSubGuild(mainGuildId, subId, user.id);
                } else {
                    result = revokeActiveByOwner(mainGuildId, user.id);
                }

                if (result.changes > 0) {
                    await interaction.editReply(`✅ 已撤销 <@${user.id}> 的 ${result.changes} 个活跃邀请码`);
                } else {
                    await interaction.editReply(`ℹ️ <@${user.id}> 没有活跃的邀请码`);
                }
                break;
            }

            // ===== 黑名单添加 =====
            case '黑名单添加': {
                const user = interaction.options.getUser('用户');
                const subId = interaction.options.getString('分服务器id') || '';
                const reason = interaction.options.getString('原因') || null;

                addToBlacklist({
                    mainGuildId,
                    userId: user.id,
                    subGuildId: subId,
                    reason,
                    createdBy: 'admin',
                });
                await interaction.editReply(`✅ 已将 <@${user.id}> 加入黑名单${subId ? `（分服 \`${subId}\`）` : '（全局）'}`);
                break;
            }

            // ===== 黑名单移除 =====
            case '黑名单移除': {
                const user = interaction.options.getUser('用户');
                const subId = interaction.options.getString('分服务器id') || '';

                const result = removeFromBlacklist(mainGuildId, user.id, subId);
                if (result.changes > 0) {
                    await interaction.editReply(`✅ 已将 <@${user.id}> 从黑名单移除`);
                } else {
                    await interaction.editReply(`ℹ️ <@${user.id}> 不在黑名单中`);
                }
                break;
            }

            // ===== 黑名单列表 =====
            case '黑名单列表': {
                const subId = interaction.options.getString('分服务器id') || '';
                const entries = getBlacklistByMainGuild(mainGuildId, subId);

                if (entries.length === 0) {
                    await interaction.editReply('黑名单为空');
                    return;
                }

                const lines = entries.map(e => {
                    const scope = e.sub_guild_id ? `分服 \`${e.sub_guild_id}\`` : '全局';
                    const reason = e.reason ? ` | ${e.reason}` : '';
                    const by = e.created_by === 'system' ? '🤖 系统' : '👤 管理员';
                    return `• <@${e.user_id}> [${scope}] ${by}${reason}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`🚫 黑名单（共 ${entries.length} 人）`)
                    .setDescription(lines.join('\n'))
                    .setColor(0xED4245)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }

            // ===== 我的状态 =====
            case '我的状态': {
                await executeMyStatus(interaction);
                break;
            }
        }
    } catch (err) {
        console.error('[ControlledInvite] 命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

// ========== 入口消息自动更新 ==========

async function tryUpdateEntryMessage(client, mainGuildId) {
    try {
        const configs = getConfigsByMainGuild(mainGuildId);
        if (configs.length === 0) return;

        // 找到有 entry_message_id 的配置
        const configWithEntry = configs.find(c => c.entry_channel_id && c.entry_message_id);
        if (!configWithEntry) return;

        const channel = await client.channels.fetch(configWithEntry.entry_channel_id).catch(() => null);
        if (!channel) return;

        const message = await channel.messages.fetch(configWithEntry.entry_message_id).catch(() => null);
        if (!message) return;

        const { buildEntryMessage } = require('../services/panelService');
        const { content, embeds, components } = await buildEntryMessage(client, mainGuildId, configs);

        await message.edit({ content, embeds, components });
    } catch (err) {
        console.error('[ControlledInvite] 更新入口消息失败:', err);
    }
}

module.exports = { data, execute, tryUpdateEntryMessage, executeMyStatus };
