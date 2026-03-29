// src\core\events\clientReady.js

const { 
    REST, 
    Routes, 
} = require('discord.js');

function normalizeDiscordToken(raw) {
    if (!raw) return '';
    let token = String(raw).trim();
    if (!token) return '';
    // 兼容某些用户误填 "Bot <token>"
    token = token.replace(/^Bot\s+/i, '').trim();
    return token;
}

function parseRequiredGuildIdsFromEnv() {
    const raw = process.env.GUILD_IDS;
    if (!raw || !raw.trim()) {
        throw new Error('缺少环境变量 GUILD_IDS。请在 .env 中配置命令注册目标服务器ID列表（逗号分隔）。');
    }

    const parsed = raw
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);

    if (parsed.length === 0) {
        throw new Error('环境变量 GUILD_IDS 为空。请至少提供一个服务器ID。');
    }

    const guildIds = [...new Set(parsed)];
    const invalid = guildIds.filter(id => !/^\d{17,20}$/.test(id));

    if (invalid.length > 0) {
        throw new Error(`GUILD_IDS 中存在无效服务器ID: ${invalid.join(', ')}`);
    }

    return guildIds;
}

async function clientReadyHandler(client){
    console.log(`Logged in as ${client.user.tag}`);

    const strictSync = String(process.env.STRICT_COMMAND_SYNC || '').toLowerCase() === 'true';
    const clearGlobalCommands = String(process.env.CLEAR_GLOBAL_COMMANDS || '').toLowerCase() === 'true';

    const token = normalizeDiscordToken(process.env.DISCORD_TOKEN);
    const rest = new REST({ version: '10'}).setToken(token);

    try{
        const commandPayload = client.commands.map((command) => command.data.toJSON());
        const targetGuildIds = parseRequiredGuildIdsFromEnv();

        // 可选：清空全局命令（之前用同一个 bot token/应用做过其它项目时，常会遗留全局命令）
        // 注意：全局命令的传播/删除在 Discord 侧可能存在缓存延迟（通常可达 ~1 小时）。
        if (clearGlobalCommands) {
            console.log('🧹 CLEAR_GLOBAL_COMMANDS=true：准备清空该应用的全局命令（Global Commands）...');
            try {
                await rest.put(
                    Routes.applicationCommands(process.env.CLIENT_ID),
                    { body: [] }
                );
                console.log('✅ 已清空全局命令。');
            } catch (globalError) {
                console.error('❌ 清空全局命令失败：', globalError?.message || globalError);
                if (strictSync) {
                    throw new Error('STRICT_COMMAND_SYNC=true：清空全局命令失败，已中止启动。请检查 CLIENT_ID / Token 权限/网络。');
                }
            }
        }

        console.log(`Start refreshing ${client.commands.size} commands for configured guilds...`);
        console.log(`目标服务器数量: ${targetGuildIds.length}`);

        const previewLines = [];
        for (const guildId of targetGuildIds) {
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (guild) {
                previewLines.push(`- ${guild.name} (${guild.id})`);
            } else {
                previewLines.push(`- [不可访问或机器人未加入] (${guildId})`);
            }
        }

        console.log('命令注册目标服务器列表:');
        console.log(previewLines.join('\n'));

        console.log(`准备向 ${targetGuildIds.length} 个服务器注册命令...`);

        let successCount = 0;
        let failCount = 0;

        // 串行注册，降低触发频繁限流概率
        for (const guildId of targetGuildIds) {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
                    {
                        body: commandPayload,
                    }
                );

                successCount++;
                const guildName = client.guilds.cache.get(guildId)?.name || guildId;
                console.log(`✅ 命令注册成功: ${guildName} (${guildId})`);
            } catch (guildError) {
                failCount++;
                const guildName = client.guilds.cache.get(guildId)?.name || guildId;
                console.error(`❌ 命令注册失败: ${guildName} (${guildId})`, guildError?.message || guildError);
            }
        }

        console.log(`Commands reload completed. Success: ${successCount}, Failed: ${failCount}, Total: ${targetGuildIds.length}`);

        if (strictSync && failCount > 0) {
            throw new Error(`STRICT_COMMAND_SYNC=true：命令同步失败（失败 ${failCount} 个服务器）。已中止启动，请检查网络/权限/GUILD_IDS/CLIENT_ID 配置。`);
        }
    } catch(error){
        console.error('❌ 命令注册流程失败，启动中止：', error);
        throw error;
    }
    
}

module.exports = {
    clientReadyHandler,
}