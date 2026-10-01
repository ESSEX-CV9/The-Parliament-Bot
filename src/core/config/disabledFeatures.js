// 这些功能已从旧 Bot 停用；拒绝 Discord 缓存中的旧命令及历史面板。
// 恢复功能时应统一恢复接入注释与此拦截规则，不能只恢复命令注册。
const DISABLED_FEATURE_MESSAGE = '⛔ 此功能已在这个 Bot 停用，请联系管理员了解后续安排。';
const disabledCommandPrefixes = ['神秘指令', '提案', '频道冲水', '上庭'];
const disabledCommands = new Set(['加压轮盘测试', '审核议案']);
const disabledManagement = new Set(['神秘名字库', '神秘频道设置', '重置游戏数据']);
const disabledComponentPrefixes = ['mystery_', 'proposal_', 'support_', 'complete_', 'court_'];
const disabledComponents = new Set([
    'open_form', 'form_submission',
    'confirm_full_cleanup', 'cancel_full_cleanup',
    'confirm_selected_cleanup', 'cancel_selected_cleanup',
]);

function isDisabledInteraction(interaction) {
    if (interaction.isChatInputCommand?.() || interaction.isAutocomplete?.()) {
        const name = interaction.commandName || '';
        if (disabledCommands.has(name) || disabledCommandPrefixes.some(prefix => name.startsWith(prefix))) return true;
        if (name === '管理' && disabledManagement.has(interaction.options.getSubcommand(false))) return true;
    }
    const customId = interaction.customId;
    return typeof customId === 'string'
        && (disabledComponents.has(customId) || disabledComponentPrefixes.some(prefix => customId.startsWith(prefix)));
}

module.exports = { isDisabledInteraction, DISABLED_FEATURE_MESSAGE };
