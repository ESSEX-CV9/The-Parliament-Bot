const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const {
    addBannedKeyword,
    removeBannedKeyword,
    getBannedKeywords,
    saveAutoCleanupSettings,
} = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-关键词')
        .setNameLocalizations({ 'en-US': 'cleanup-keywords' })
        .setDescription('管理违禁关键字（添加 / 删除 / 查看）')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

        .addSubcommand(sub => sub
            .setName('添加')
            .setDescription('添加一个违禁关键字到自动清理列表')
            .addStringOption(opt => opt
                .setName('关键字')
                .setNameLocalizations({ 'en-US': 'keyword' })
                .setDescription('要添加的违禁关键字（支持正则表达式，格式：/pattern/）')
                .setRequired(true)
            )
        )
        .addSubcommand(sub => sub
            .setName('删除')
            .setDescription('从自动清理列表中移除一个违禁关键字')
            .addStringOption(opt => opt
                .setName('关键字')
                .setNameLocalizations({ 'en-US': 'keyword' })
                .setDescription('要移除的违禁关键字')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand(sub => sub
            .setName('查看')
            .setDescription('查看当前服务器的所有违禁关键字')
        ),

    // ========== Autocomplete（删除子命令需要） ==========
    async autocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const guildId = interaction.guild.id;
            const bannedKeywords = await getBannedKeywords(guildId);
            const filtered = bannedKeywords
                .filter(kw => kw.toLowerCase().includes(focusedValue.toLowerCase()))
                .slice(0, 25);
            await interaction.respond(
                filtered.map(kw => ({
                    name: kw.length > 100 ? kw.substring(0, 97) + '...' : kw,
                    value: kw,
                }))
            );
        } catch (err) {
            console.error('自动完成违禁关键字时出错:', err);
            await interaction.respond([]);
        }
    },

    // ========== Execute ==========
    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;

            switch (sub) {
                // ────── 添加 ──────
                case '添加': {
                    const keyword = interaction.options.getString('关键字');

                    if (!keyword || keyword.trim().length === 0) {
                        return await interaction.editReply({ content: '❌ 关键字不能为空！' });
                    }
                    if (keyword.length > 100) {
                        return await interaction.editReply({ content: '❌ 关键字长度不能超过100个字符！' });
                    }
                    if (keyword.startsWith('/') && keyword.endsWith('/')) {
                        try { new RegExp(keyword.slice(1, -1), 'i'); }
                        catch (_) { return await interaction.editReply({ content: '❌ 无效的正则表达式格式！请检查语法。' }); }
                    }

                    const settings = await addBannedKeyword(guildId, keyword);
                    const keywordCount = settings.bannedKeywords.filter(k => k === keyword).length;
                    if (keywordCount > 1) {
                        settings.bannedKeywords = [...new Set(settings.bannedKeywords)];
                        await saveAutoCleanupSettings(guildId, settings);
                        return await interaction.editReply({ content: '⚠️ 该关键字已存在于列表中！' });
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('✅ 违禁关键字已添加')
                        .setDescription(`成功添加违禁关键字：\`${keyword}\``)
                        .addFields(
                            { name: '当前违禁关键字数量', value: `${settings.bannedKeywords.length}`, inline: true },
                            { name: '类型', value: keyword.startsWith('/') && keyword.endsWith('/') ? '正则表达式' : '普通关键字', inline: true },
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();

                    console.log(`✅ 添加违禁关键字 - Guild: ${guildId}, Keyword: ${keyword}, User: ${interaction.user.tag}`);
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                // ────── 删除 ──────
                case '删除': {
                    const keyword = interaction.options.getString('关键字');
                    const currentKeywords = await getBannedKeywords(guildId);

                    if (!currentKeywords.includes(keyword)) {
                        return await interaction.editReply({ content: '❌ 该关键字不在违禁列表中！' });
                    }

                    const settings = await removeBannedKeyword(guildId, keyword);
                    const embed = new EmbedBuilder()
                        .setTitle('✅ 违禁关键字已移除')
                        .setDescription(`成功移除违禁关键字：\`${keyword}\``)
                        .addFields({ name: '剩余违禁关键字数量', value: `${settings.bannedKeywords.length}`, inline: true })
                        .setColor(0x00ff00)
                        .setTimestamp();

                    console.log(`✅ 移除违禁关键字 - Guild: ${guildId}, Keyword: ${keyword}, User: ${interaction.user.tag}`);
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                // ────── 查看 ──────
                case '查看': {
                    const bannedKeywords = await getBannedKeywords(guildId);

                    if (bannedKeywords.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle('📋 违禁关键字列表')
                            .setDescription('当前没有设置任何违禁关键字。')
                            .setColor(0xffa500)
                            .setTimestamp();
                        return await interaction.editReply({ embeds: [embed] });
                    }

                    const pageSize = 10;
                    const totalPages = Math.ceil(bannedKeywords.length / pageSize);
                    const currentKeywords = bannedKeywords.slice(0, pageSize);

                    const embed = new EmbedBuilder()
                        .setTitle('📋 违禁关键字列表')
                        .setDescription(`服务器 **${interaction.guild.name}** 的违禁关键字`)
                        .setColor(0x00ff00)
                        .setTimestamp();

                    let keywordList = '';
                    currentKeywords.forEach((kw, index) => {
                        const type = kw.startsWith('/') && kw.endsWith('/') ? '正则' : '普通';
                        const display = kw.length > 50 ? kw.substring(0, 47) + '...' : kw;
                        keywordList += `**${index + 1}.** \`${display}\` (${type})\n`;
                    });

                    embed.addFields(
                        { name: '关键字列表', value: keywordList || '无', inline: false },
                        { name: '📊 统计信息', value: `总计: ${bannedKeywords.length} 个关键字`, inline: true },
                    );
                    if (totalPages > 1) {
                        embed.addFields({ name: '📄 分页信息', value: `第 1/${totalPages} 页`, inline: true });
                    }
                    const regexCount = bannedKeywords.filter(k => k.startsWith('/') && k.endsWith('/')).length;
                    embed.addFields({ name: '📈 类型分布', value: `普通: ${bannedKeywords.length - regexCount} | 正则: ${regexCount}`, inline: true });

                    await interaction.editReply({ embeds: [embed] });
                    break;
                }
            }
        } catch (error) {
            console.error('违禁关键字操作出错:', error);
            await interaction.editReply({ content: `❌ 操作失败：${error.message || '未知错误'}` });
        }
    },
};
