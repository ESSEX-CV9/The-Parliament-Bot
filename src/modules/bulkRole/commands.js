const { MessageFlags } = require('discord.js');
const { getService } = require('./service');
const { previewPayload, resultPayload, MENTIONS } = require('./presentation');

const PREFIX = 'bulkrole:';

function addRoleGroup(builder) {
    return builder.addSubcommandGroup(group => group
        .setName('身份组').setDescription('安全批量管理指定成员身份组')
        .addSubcommand(command => command
            .setName('批量操作').setDescription('预览并确认批量添加或移除身份组')
            .addStringOption(option => option.setName('操作').setDescription('添加或移除指定身份组').setRequired(true)
                .addChoices({ name: '添加', value: 'add' }, { name: '移除', value: 'remove' }))
            .addRoleOption(option => option.setName('身份组').setDescription('需要添加或移除的身份组').setRequired(true))
            .addStringOption(option => option.setName('用户id列表').setDescription('用户 ID，以英文逗号分隔；最多 200 个去重 ID').setRequired(true).setMaxLength(6000)))
        .addSubcommand(command => command.setName('任务').setDescription('私密查询、取消任务或预览重试失败项')
            .addStringOption(option => option.setName('任务id').setDescription('确认后生成的任务 ID；不填查询您最近的任务').setRequired(false).setMaxLength(36))
            .addStringOption(option => option.setName('操作').setDescription('默认查询；重试失败也需二次确认').setRequired(false)
                .addChoices({ name: '状态', value: 'status' }, { name: '取消', value: 'cancel' }, { name: '重试失败', value: 'retry' }))));
}

function errorMessage(error) {
    if (error?.code === 'SAFETY') return error.message;
    if (/^(用户ID|第 \d+ 项|去重后|只有原始|预览|此服务器|任务不存在|请等待|此任务没有|操作必须)/.test(error?.message)) return error.message;
    return '操作或反馈失败。已确认任务请用 `/管理 身份组 任务` 查询，并检查 Bot 权限、Discord 连接和本地数据库。';
}

function createHandlers({ getService: serviceFor = getService } = {}) {
    async function execute(interaction) {
        if (!interaction.inGuild()) return interaction.reply({ content: '此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral, allowedMentions: MENTIONS });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const service = serviceFor(interaction.client);
            const guildId = interaction.guild.id;
            const actorId = interaction.user.id;
            if (interaction.options.getSubcommand() === '批量操作') {
                const preview = await service.preview({ guildId, actorId, roleId: interaction.options.getRole('身份组', true).id,
                    action: interaction.options.getString('操作', true) }, interaction.options.getString('用户id列表', true));
                return interaction.editReply(previewPayload(preview));
            }
            const id = interaction.options.getString('任务id');
            const action = interaction.options.getString('操作') || 'status';
            if (action === 'retry') return interaction.editReply(previewPayload(await service.retryPreview(id, guildId, actorId)));
            if (action === 'cancel') await service.cancel(id, guildId, actorId);
            const result = await service.result(id, guildId, actorId);
            await interaction.editReply(resultPayload(result));
            if (['queued', 'running'].includes(result.job.status)) service.watch(result.job.id, value => interaction.editReply(resultPayload(value)));
            if (action === 'cancel') service.kick();
        } catch (error) {
            await interaction.editReply({ content: `❌ ${errorMessage(error)}`, components: [], attachments: [], allowedMentions: MENTIONS });
        }
    }

    async function button(interaction) {
        let service;
        try {
            const match = /^bulkrole:(confirm|cancel):([a-f0-9-]{36})$/.exec(interaction.customId);
            if (!match || !interaction.inGuild()) throw new Error('预览无效，请重新发起。');
            service = serviceFor(interaction.client);
            const [, action, id] = match;
            // Synchronous ownership check before acknowledging an update to the original
            // private message. An outsider only receives their own ephemeral error.
            const preview = service.store.requirePreview(id, interaction.guild.id, interaction.user.id, service.now());
            await interaction.deferUpdate();
            if (action === 'cancel') {
                await service.safety.authorize(preview);
                service.store.cancelPreview(id, preview.guildId, preview.actorId, service.now());
                return interaction.editReply({ content: '已取消预览，未修改任何成员身份组。', components: [], attachments: [], allowedMentions: MENTIONS });
            }
            const job = await service.confirm(id, preview.guildId, preview.actorId);
            await interaction.editReply(resultPayload({ job, rows: service.store.rows(job.id) }));
            service.watch(job.id, value => interaction.editReply(resultPayload(value)));
            service.kick();
        } catch (error) {
            const payload = { content: `❌ ${errorMessage(error)}`, flags: MessageFlags.Ephemeral, allowedMentions: MENTIONS };
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
            else await interaction.reply(payload);
        }
    }

    return { execute, button };
}

const handlers = createHandlers();
module.exports = { PREFIX, addRoleGroup, createHandlers, executeBulkRole: handlers.execute, handleBulkRoleButton: handlers.button };
