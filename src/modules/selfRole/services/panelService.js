// src/modules/selfRole/services/panelService.js

const { EmbedBuilder } = require('discord.js');

const {
    getSelfRoleSettings,
    countActiveSelfRoleGrantHoldersByRole,
    countReservedPendingSelfRoleApplicationsV2,
    getActiveSelfRolePanels,
    touchSelfRolePanelRenderedAt,
} = require('../../../core/utils/database');

const STATUS_SECTION_HEADER = '【岗位状态】';
const DETAIL_SECTION_HEADER = '【岗位详情】';

// 统一做一个很轻量的刷新防抖，避免短时间内多次触发导致频繁 edit 消息
const REFRESH_DEBOUNCE_MS = 3000;
const refreshTimers = new Map();

function formatDateTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return String(ts);
    }
}

async function buildCompactStatusLines(guild, settings, options = {}) {
    const guildId = guild.id;
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

    const roleFilter = Array.isArray(options.roleIds) ? new Set(options.roleIds.filter(Boolean)) : null;
    const roleStats = options.roleStats instanceof Map ? options.roleStats : null;

    let allRoles = options.allRoles;
    if (!allRoles) {
        try {
            allRoles = await guild.roles.fetch();
        } catch (err) {
            console.error('[SelfRole][Panel] ❌ 拉取身份组列表失败:', err);
            allRoles = guild.roles.cache;
        }
    }

    const roleLines = [];

    for (const roleConfig of settings?.roles || []) {
        const roleId = roleConfig?.roleId;
        if (!roleId) continue;
        if (roleFilter && !roleFilter.has(roleId)) continue;

        const role = allRoles.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
        if (!role) {
            roleLines.push(`• <@&${roleId}>：⚠️ 身份组不可用（可能已删除或机器人权限不足）`);
            continue;
        }

        let holders;
        let pending;
        if (roleStats && roleStats.has(roleId)) {
            const snap = roleStats.get(roleId) || {};
            holders = Number(snap.holders || 0);
            pending = Number(snap.pending || 0);
        } else {
            holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
            pending = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, nowMs);
        }

        const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
        const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
        const maxText = hasLimit ? String(maxMembers) : '∞';
        const vacancyText = hasLimit ? String(Math.max(0, maxMembers - holders - pending)) : '∞';

        roleLines.push(`• <@&${roleId}>：现任 **${holders}** / 上限 **${maxText}**，空缺 **${vacancyText}**，待审核 **${pending}**`);
    }

    if (roleLines.length === 0) {
        return ['（当前暂无可申请身份组配置）'];
    }

    const lines = [...roleLines];

    // 控制在 Embed description 长度限制内
    const result = [];
    let acc = 0;
    for (const line of lines) {
        if (acc + line.length + 1 > 1800) {
            result.push('…（其余身份组省略，请联系管理员或拆分面板）');
            break;
        }
        result.push(line);
        acc += line.length + 1;
    }
    return result;
}

function describeReasonConfig(rc) {
    if (!rc || typeof rc !== 'object') return null;
    const mode = rc.mode;
    if (mode === 'disabled') return '申请理由：禁用';
    const modeText = mode === 'required' ? '必填' : (mode === 'optional' ? '可选' : String(mode || ''));
    const minText = typeof rc.minLen === 'number' ? rc.minLen : '默认10';
    const maxText = typeof rc.maxLen === 'number' ? rc.maxLen : '默认500';
    return `申请理由：${modeText}（长度 ${minText}–${maxText}）`;
}

function describeActivityConfig(a) {
    if (!a || typeof a !== 'object') return null;
    if (!a.channelId) return null;

    const parts = [];
    if (a.requiredMessages > 0) parts.push(`发言≥${a.requiredMessages}`);
    if (a.requiredMentions > 0) parts.push(`被提及≥${a.requiredMentions}`);
    if (a.requiredMentioning > 0) parts.push(`主动提及≥${a.requiredMentioning}`);
    const main = parts.length > 0 ? parts.join('，') : '无额外阈值';

    let extra = '';
    if (a.activeDaysThreshold) {
        const dt = a.activeDaysThreshold;
        extra = `；活跃天数：每日发言≥${dt.dailyMessageThreshold}，需 ${dt.requiredActiveDays} 天`;
    }

    return `活跃度：<#${a.channelId}>（${main}${extra}）`;
}

function describeApprovalConfig(ap) {
    if (!ap || typeof ap !== 'object') return null;
    const channel = ap.channelId ? `<#${ap.channelId}>` : '（未配置频道）';
    const votes = ap.requiredApprovals && ap.requiredRejections
        ? `${ap.requiredApprovals} 支持 / ${ap.requiredRejections} 反对`
        : '（未配置票数阈值）';
    return `申请方式：需要审核（${channel}；${votes}）`;
}

function describeLifecycleConfig(lc) {
    if (!lc || typeof lc !== 'object') return null;
    const hasAny =
        lc.enabled === true ||
        (typeof lc.inquiryDays === 'number' && lc.inquiryDays > 0) ||
        (typeof lc.forceRemoveDays === 'number' && lc.forceRemoveDays > 0) ||
        lc.onlyWhenFull === true ||
        !!lc.reportChannelId;
    if (!hasAny) return null;

    let text = `周期清退：${lc.enabled ? '启用' : '未启用'}`;
    if (typeof lc.inquiryDays === 'number') {
        text += lc.inquiryDays > 0 ? `；询问 ${lc.inquiryDays} 天` : '；不询问';
    }
    if (typeof lc.forceRemoveDays === 'number') {
        text += lc.forceRemoveDays > 0 ? `；强制清退 ${lc.forceRemoveDays} 天` : '；不强制';
    }
    if (lc.onlyWhenFull) {
        text += '；仅满员执行';
    }
    return text;
}

async function buildRichDetailLines(guild, settings, options = {}) {
    const guildId = guild.id;
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

    const roleFilter = Array.isArray(options.roleIds) ? new Set(options.roleIds.filter(Boolean)) : null;
    const roleStats = options.roleStats instanceof Map ? options.roleStats : null;

    let allRoles = options.allRoles;
    if (!allRoles) {
        try {
            allRoles = await guild.roles.fetch();
        } catch (err) {
            console.error('[SelfRole][Panel] ❌ 拉取身份组列表失败:', err);
            allRoles = guild.roles.cache;
        }
    }

    const roles = settings?.roles || [];
    if (!Array.isArray(roles) || roles.length === 0) {
        return ['（当前暂无可申请身份组配置）'];
    }

    const lines = [];

    // 控制在 Embed description 长度限制内
    const LIMIT = 3800;
    let acc = lines.join('\n').length;

    for (const roleConfig of roles) {
        const roleId = roleConfig?.roleId;
        if (!roleId) continue;
        if (roleFilter && !roleFilter.has(roleId)) continue;

        const role = allRoles.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
        if (!role) {
            const block = `• <@&${roleId}>：⚠️ 身份组不可用（可能已删除或机器人权限不足）\n`;
            if (acc + block.length > LIMIT) break;
            lines.push(block.trimEnd());
            acc += block.length;
            continue;
        }

        const label = roleConfig?.label || role.name;
        const description = String(roleConfig?.description || '').trim();

        let holders;
        let pending;
        if (roleStats && roleStats.has(roleId)) {
            const snap = roleStats.get(roleId) || {};
            holders = Number(snap.holders || 0);
            pending = Number(snap.pending || 0);
        } else {
            holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
            pending = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, nowMs);
        }
        const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
        const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;
        const maxText = hasLimit ? String(maxMembers) : '∞';
        const vacancyText = hasLimit ? String(Math.max(0, maxMembers - holders - pending)) : '∞';

        const blockLines = [];
        blockLines.push(`• <@&${roleId}>：**${label}**`);
        if (description) {
            blockLines.push(`  - ${description.length > 200 ? description.slice(0, 197) + '…' : description}`);
        }
        blockLines.push(`  - 名额：现任 **${holders}** / 上限 **${maxText}**，空缺 **${vacancyText}**，待审核 **${pending}**`);

        const prereq = roleConfig?.conditions?.prerequisiteRoleId;
        if (prereq) {
            blockLines.push(`  - 前置身份组：<@&${prereq}>`);
        }

        const ap = roleConfig?.conditions?.approval;
        if (ap) {
            const apText = describeApprovalConfig(ap);
            if (apText) blockLines.push(`  - ${apText}`);
        } else {
            blockLines.push('  - 申请方式：直授（无需审核）');
        }

        const actText = describeActivityConfig(roleConfig?.conditions?.activity);
        if (actText) {
            blockLines.push(`  - ${actText}`);
        }

        const reasonText = describeReasonConfig(roleConfig?.conditions?.reason);
        if (reasonText) {
            blockLines.push(`  - ${reasonText}`);
        }

        const bundle = Array.isArray(roleConfig?.bundleRoleIds) ? roleConfig.bundleRoleIds.filter(Boolean) : [];
        if (bundle.length > 0) {
            blockLines.push(`  - 附带身份组：${bundle.map((rid) => `<@&${rid}>`).join('，')}`);
        }

        const lcText = describeLifecycleConfig(roleConfig?.lifecycle);
        if (lcText) {
            blockLines.push(`  - ${lcText}`);
        }

        blockLines.push('');

        const block = blockLines.join('\n');
        if (acc + block.length > LIMIT) {
            lines.push('…（其余岗位省略：面板过长。请联系管理员，或拆分为多个面板。）');
            break;
        }

        lines.push(...blockLines);
        acc += block.length;
    }

    while (lines.length > 0 && !lines[lines.length - 1]) {
        lines.pop();
    }

    return lines;
}

function upsertStatusSection(baseDescription, statusLines) {
    const desc = typeof baseDescription === 'string' ? baseDescription : '';
    const marker = STATUS_SECTION_HEADER;
    const section = `${marker}\n${statusLines.join('\n')}`;

    if (!desc) {
        return section;
    }

    const idx = desc.indexOf(marker);
    if (idx === -1) {
        return `${desc}\n\n---\n${section}`;
    }

    // 尝试找到 marker 前最近的分隔线 "---"，以便替换整段状态区
    const beforeMarker = desc.slice(0, idx);
    const sepIdx = beforeMarker.lastIndexOf('---');

    const prefix = (sepIdx >= 0 ? desc.slice(0, sepIdx) : beforeMarker).trimEnd();
    if (!prefix) {
        return section;
    }

    return `${prefix}\n\n---\n${section}`;
}

async function refreshActiveUserSelfRolePanels(client, guildId) {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;

    const settings = await getSelfRoleSettings(guildId);
    const panels = await getActiveSelfRolePanels(guildId, 'user');
    if (!panels || panels.length === 0) return;

    const nowMs = Date.now();

    // 1) 尽量只 fetch 一次 roles，避免多个面板刷新时重复请求
    let allRoles;
    try {
        allRoles = await guild.roles.fetch();
    } catch (err) {
        console.error('[SelfRole][Panel] ❌ 拉取身份组列表失败:', err);
        allRoles = guild.roles.cache;
    }

    // 2) 为本次刷新构建一次“现任/待审核”快照，避免同一 tick 内重复查询
    const roleStats = new Map();
    const roleConfigs = Array.isArray(settings?.roles) ? settings.roles : [];
    for (const rc of roleConfigs) {
        const roleId = rc?.roleId;
        if (!roleId) continue;
        const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleId);
        const pending = await countReservedPendingSelfRoleApplicationsV2(guildId, roleId, nowMs);
        roleStats.set(roleId, { holders, pending });
    }

    const linesCache = new Map();

    for (const panel of panels) {
        try {
            const cacheKey = panel.roleIds ? panel.roleIds.slice().sort().join(',') : '*';
            let cached = linesCache.get(cacheKey);
            if (!cached) {
                const statusLines = await buildCompactStatusLines(guild, settings, {
                    roleIds: panel.roleIds,
                    allRoles,
                    roleStats,
                    nowMs,
                });
                const detailLines = await buildRichDetailLines(guild, settings, {
                    roleIds: panel.roleIds,
                    allRoles,
                    roleStats,
                    nowMs,
                });
                cached = { statusLines, detailLines };
                linesCache.set(cacheKey, cached);
            }

            const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) continue;

            const message = await channel.messages.fetch(panel.messageId).catch(() => null);
            if (!message) continue;

            const embeds = message.embeds || [];

            // Rich 模式：embed[1] 为“岗位状态”，embed[2] 为“岗位详情”（可选）
            if (embeds.length >= 2 && embeds[1]?.title === STATUS_SECTION_HEADER) {
                const updatedEmbeds = [];

                // 0) 静态说明区：尽量保留管理员自定义
                const head = embeds[0] ? new EmbedBuilder(embeds[0].data) : new EmbedBuilder();
                updatedEmbeds.push(head);

                // 1) 状态区
                const statusEmbed = embeds[1]
                    ? new EmbedBuilder(embeds[1].data)
                    : new EmbedBuilder().setColor(0x5865F2);
                statusEmbed.setTitle(STATUS_SECTION_HEADER);
                statusEmbed.setDescription(cached.statusLines.join('\n'));
                statusEmbed.setFooter({ text: `最后刷新：${formatDateTime(Date.now())}` });
                updatedEmbeds.push(statusEmbed);

                // 2) 详情区（若存在）
                if (embeds[2]?.title === DETAIL_SECTION_HEADER) {
                    const detailEmbed = new EmbedBuilder(embeds[2].data);
                    detailEmbed.setTitle(DETAIL_SECTION_HEADER);
                    detailEmbed.setDescription(cached.detailLines.join('\n'));
                    detailEmbed.setFooter({ text: `最后刷新：${formatDateTime(Date.now())}` });
                    updatedEmbeds.push(detailEmbed);
                }

                // 3) 其余 embeds 原样保留（避免误删）
                if (embeds.length > updatedEmbeds.length) {
                    for (let i = updatedEmbeds.length; i < embeds.length; i++) {
                        updatedEmbeds.push(new EmbedBuilder(embeds[i].data));
                    }
                }

                await message.edit({ embeds: updatedEmbeds }).catch(() => {});
                await touchSelfRolePanelRenderedAt(panel.panelId).catch(() => {});
                continue;
            }

            // 兼容旧模式：在同一 embed.description 内维护“岗位状态”区块
            const originalEmbed = embeds?.[0];
            const updated = originalEmbed ? new EmbedBuilder(originalEmbed.data) : new EmbedBuilder();

            const originalDesc = originalEmbed?.description || '';
            updated.setDescription(upsertStatusSection(originalDesc, cached.statusLines));

            // 不强制改标题/颜色，避免破坏管理员自定义内容
            updated.setFooter({ text: `最后刷新：${formatDateTime(Date.now())}` });

            await message.edit({ embeds: [updated] }).catch(() => {});
            await touchSelfRolePanelRenderedAt(panel.panelId).catch(() => {});
        } catch (err) {
            console.error('[SelfRole][Panel] ❌ 刷新面板失败:', err);
        }
    }
}

function scheduleActiveUserSelfRolePanelsRefresh(client, guildId, reason = '') {
    if (!guildId) return;

    if (refreshTimers.has(guildId)) {
        return;
    }

    const timer = setTimeout(() => {
        refreshTimers.delete(guildId);
        refreshActiveUserSelfRolePanels(client, guildId)
            .then(() => {
                if (reason) {
                    console.log(`[SelfRole][Panel] ✅ 已刷新用户面板 guild=${guildId} reason=${reason}`);
                }
            })
            .catch(err => console.error('[SelfRole][Panel] ❌ 刷新用户面板时出错:', err));
    }, REFRESH_DEBOUNCE_MS);

    refreshTimers.set(guildId, timer);
}

module.exports = {
    STATUS_SECTION_HEADER,
    DETAIL_SECTION_HEADER,
    buildCompactStatusLines,
    buildRichDetailLines,
    upsertStatusSection,
    refreshActiveUserSelfRolePanels,
    scheduleActiveUserSelfRolePanelsRefresh,
};
