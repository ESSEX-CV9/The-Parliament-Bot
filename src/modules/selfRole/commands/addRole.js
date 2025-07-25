// src/modules/selfRole/commands/addRole.js

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getSelfRoleSettings, saveSelfRoleSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('添加可申请身份组')
        .setDescription('添加一个新的可申请身份组及其申请条件')
        .addStringOption(option =>
            option.setName('身份组id')
                .setDescription('要添加的可申请身份组的ID')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('显示名称')
                .setDescription('在下拉菜单中显示的名称')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('描述')
                .setDescription('在下拉菜单中显示的描述')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('前置身份组id')
                .setDescription('申请此身份组所需的前置身份组的ID（可选）')
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('活跃度统计频道')
                .setDescription('如果需要统计活跃度，请指定频道（可选）')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName('所需发言数')
                .setDescription('如果需要统计活跃度，请指定所需发言数（可选）')
                .setMinValue(1)
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName('所需提及数')
                .setDescription('如果需要统计活跃度，请指定所需被提及数（可选）')
                .setMinValue(1)
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guild.id;
        const roleIdToAdd = interaction.options.getString('身份组id');
        const label = interaction.options.getString('显示名称');
        const description = interaction.options.getString('描述');
        const prerequisiteRoleId = interaction.options.getString('前置身份组id');
        const activityChannel = interaction.options.getChannel('活跃度统计频道');
        const requiredMessages = interaction.options.getInteger('所需发言数');
        const requiredMentions = interaction.options.getInteger('所需提及数');

        // 参数逻辑验证
        if ((requiredMessages || requiredMentions) && !activityChannel) {
            return interaction.editReply({ content: '❌ 如果设置了发言数或提及数要求，则必须指定一个活跃度统计频道。' });
        }
        if (activityChannel && !requiredMessages && !requiredMentions) {
            return interaction.editReply({ content: '❌ 如果指定了活跃度统计频道，则至少需要设置一个发言数或提及数要求。' });
        }

        try {
            let settings = await getSelfRoleSettings(guildId);
            if (!settings) {
                return interaction.editReply({ content: '❌ 请先使用 `/创建自助身份组面板` 命令初始化系统。' });
            }

            // 验证身份组ID是否存在
            const roleToAdd = await interaction.guild.roles.fetch(roleIdToAdd).catch(() => null);
            if (!roleToAdd) {
                return interaction.editReply({ content: `❌ 未能找到ID为 \`${roleIdToAdd}\` 的身份组。` });
            }

            // 检查身份组是否已存在
            if (settings.roles.some(r => r.roleId === roleToAdd.id)) {
                return interaction.editReply({ content: `❌ 身份组 **${roleToAdd.name}** 已经存在于可申请列表中。` });
            }

            const newRoleConfig = {
                roleId: roleToAdd.id,
                label: label,
                description: description,
                conditions: {},
            };

            if (prerequisiteRoleId) {
                const prerequisiteRole = await interaction.guild.roles.fetch(prerequisiteRoleId).catch(() => null);
                if (!prerequisiteRole) {
                    return interaction.editReply({ content: `❌ 未能找到前置身份组ID为 \`${prerequisiteRoleId}\` 的身份组。` });
                }
                newRoleConfig.conditions.prerequisiteRoleId = prerequisiteRole.id;
            }

            if (activityChannel) {
                newRoleConfig.conditions.activity = {
                    channelId: activityChannel.id,
                    requiredMessages: requiredMessages || 0,
                    requiredMentions: requiredMentions || 0,
                };
            }

            settings.roles.push(newRoleConfig);
            await saveSelfRoleSettings(guildId, settings);

            console.log(`[SelfRole] ✅ 添加了新的可申请身份组: ${label} (${roleToAdd.name})`);
            await interaction.editReply({ content: `✅ 成功添加了可申请身份组 **${label}**！` });

        } catch (error) {
            console.error('[SelfRole] ❌ 添加可申请身份组时出错:', error);
            await interaction.editReply({ content: '❌ 添加身份组时发生未知错误。' });
        }
    },
};