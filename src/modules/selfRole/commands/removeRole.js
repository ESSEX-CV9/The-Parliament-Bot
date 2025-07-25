// src/modules/selfRole/commands/removeRole.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSelfRoleSettings, saveSelfRoleSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('移除可申请身份组')
        .setDescription('从自助申请列表中移除一个身份组')
        .addStringOption(option =>
            option.setName('身份组')
                .setDescription('要移除的身份组')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async autocomplete(interaction) {
        console.log('[SelfRole-Autocomplete] 收到移除身份组的自动补全请求...');
        try {
            const guildId = interaction.guild.id;
            console.log(`[SelfRole-Autocomplete] 服务器ID: ${guildId}`);

            const settings = await getSelfRoleSettings(guildId);
            if (!settings || !settings.roles || settings.roles.length === 0) {
                console.log('[SelfRole-Autocomplete] 未找到设置或角色列表为空，返回空数组。');
                await interaction.respond([]);
                return;
            }
            console.log(`[SelfRole-Autocomplete] 成功获取到 ${settings.roles.length} 个已配置的角色。`);

            const focusedValue = interaction.options.getFocused();
            console.log(`[SelfRole-Autocomplete] 用户输入内容: "${focusedValue}"`);

            const choices = settings.roles.map(roleConfig => ({
                name: `${roleConfig.label} (ID: ${roleConfig.roleId})`, // 在名称中也显示ID，方便确认
                value: roleConfig.roleId
            }));
            console.log('[SelfRole-Autocomplete] 生成的选项:', choices);

            const filtered = choices.filter(choice =>
                choice.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
                choice.value.includes(focusedValue)
            );
            console.log(`[SelfRole-Autocomplete] 过滤后的选项: ${filtered.length} 个`);

            await interaction.respond(filtered.slice(0, 25));
            console.log('[SelfRole-Autocomplete] 成功响应自动补全请求。');
        } catch (error) {
            console.error('[SelfRole] ❌ Autocomplete处理出错:', error);
            // 即使出错，也要尝试发送一个空响应，防止交互失败
            if (!interaction.responded) {
                await interaction.respond([]).catch(err => console.error('[SelfRole] ❌ 响应空数组时也出错了:', err));
            }
        }
    },

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guild.id;
        const roleIdToRemove = interaction.options.getString('身份组');

        try {
            let settings = await getSelfRoleSettings(guildId);
            if (!settings || !settings.roles || settings.roles.length === 0) {
                return interaction.editReply({ content: '❌ 当前没有配置任何可申请的身份组。' });
            }

            const initialRoleCount = settings.roles.length;
            const roleConfigToRemove = settings.roles.find(r => r.roleId === roleIdToRemove);
            
            if (!roleConfigToRemove) {
                return interaction.editReply({ content: `❌ 在可申请列表中未找到所选的身份组。` });
            }
            
            const roleName = roleConfigToRemove.label;
            settings.roles = settings.roles.filter(r => r.roleId !== roleIdToRemove);

            if (settings.roles.length === initialRoleCount) {
                return interaction.editReply({ content: `❌ 移除身份组 **${roleName}** 失败。` });
            }

            await saveSelfRoleSettings(guildId, settings);

            console.log(`[SelfRole] ✅ 移除了可申请身份组: ${roleName}`);
            await interaction.editReply({ content: `✅ 成功移除了可申请身份组 **${roleName}**！` });

        } catch (error) {
            console.error('[SelfRole] ❌ 移除可申请身份组时出错:', error);
            await interaction.editReply({ content: '❌ 移除身份组时发生未知错误。' });
        }
    },
};