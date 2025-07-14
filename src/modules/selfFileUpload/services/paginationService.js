const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * 创建一个可翻页的嵌入式消息来显示列表。
 * @param {import('discord.js').CommandInteraction} interaction - The interaction object.
 * @param {string[]} listItems - 要显示的字符串数组。
 * @param {object} options - 配置选项。
 * @param {string} options.title - Embed 的标题。
 * @param {number} [options.itemsPerPage=10] - 每页显示的项目数。
 * @param {number} [options.time=120000] - 收集器持续时间（毫秒）。
 */
async function createPaginatedList(interaction, listItems, { title, itemsPerPage = 10, time = 120000 }) {
    const totalPages = Math.ceil(listItems.length / itemsPerPage);
    let currentPage = 1;

    const generateEmbed = (page) => {
        const start = (page - 1) * itemsPerPage;
        const end = start + itemsPerPage;
        const currentItems = listItems.slice(start, end);
        const description = currentItems.join('\n');

        return new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor('#e74c3c')
            .setFooter({ text: `第 ${page} / ${totalPages} 页 | 共 ${listItems.length} 个项目` })
            .setTimestamp();
    };

    const generateButtons = (page) => {
        return new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('prev_page').setLabel('◀️ 上一页').setStyle(ButtonStyle.Primary).setDisabled(page === 1),
                new ButtonBuilder().setCustomId('next_page').setLabel('下一页 ▶️').setStyle(ButtonStyle.Primary).setDisabled(page === totalPages)
            );
    };

    const embed = generateEmbed(currentPage);
    const components = totalPages > 1 ? [generateButtons(currentPage)] : [];
    const reply = await interaction.editReply({ embeds: [embed], components });

    if (totalPages <= 1) return;

    const collector = reply.createMessageComponentCollector({ time });

    collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
            return i.reply({ content: '你不能操作这个按钮。', ephemeral: true });
        }
        i.customId === 'prev_page' ? currentPage-- : currentPage++;
        await i.update({ embeds: [generateEmbed(currentPage)], components: [generateButtons(currentPage)] });
    });

    collector.on('end', () => {
        const disabledButtons = generateButtons(currentPage);
        disabledButtons.components.forEach(button => button.setDisabled(true));
        interaction.editReply({ components: [disabledButtons] }).catch(() => {});
    });
}

module.exports = { createPaginatedList };