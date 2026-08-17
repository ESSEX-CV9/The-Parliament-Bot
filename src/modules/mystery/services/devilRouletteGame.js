/**
 * 恶魔轮盘交互层（PvP 挑战）。
 *
 * 面板/按钮/流程/文案：
 *   - ChallengeView：⚔️ 应战 / 接受挑战 / 拒绝 / 🛑 发起人取消 / 📖 游戏规则
 *   - GameView：当前回合指示 + 🔫 打对手 + 💀 打自己 + 道具按钮 + 💉 肾上腺素选择器
 *              + 📜 我的情报 + 📖 游戏规则
 *   - 播报面板（开枪/装填）、🎁 道具使用聚合面板、仅你可见情报/游戏规则（含认输）
 *   - 🏆 结算面板（胜者选惩罚：禁言 5 / 改名 10，认输口径 3/7，30s 未选自动禁言 5）
 *
 * 引擎状态机走 core/devilRouletteEngine（一局定胜负）。
 * 走 mystery 骨架：gameManager 锁、custom-id 路由前缀 mystery_devil_roulette_、
 * mysteryNicknameLock 昵称锁（改名惩罚落地与到期恢复）。
 */

const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const nicknameLock = require('./mysteryNicknameLock');
const { ORDINARY_LOCK_TYPES } = require('./mysteryNicknameLockService');
const resumeStore = require('../utils/devilRouletteResumeStore');
const {
    DevilState,
    InvalidAction,
    defaultRng,
    ITEM_DEFS,
    GAME_CONFIG,
    SURRENDER_MIN_HP,
} = require('../core/devilRouletteEngine');

// ── 常量 ────────────────────────────────────────────────────────────────────

const CHALLENGE_SECONDS = 120; // 挑战 / 公屏擂台等待时长（无人应战自动取消）
const TURN_SECONDS = 60;
const GRACE_SECONDS = 2;
const EPHEMERAL_TTL_MS = 60_000; // 仅自己可见的一次性窗口默认 TTL
const PANEL_HISTORY_LIMIT = 3; // 滚动窗口上限
const ITEM_LOG_LIMIT = 6; // 道具使用面板内最多保留的操作块数
const PRIVATE_PANEL_LABEL = '📜 我的情报';
const ITEM_HELP_LABEL = '📖 游戏规则';
const PENALTY_MUTE_MINUTES = 5;
const PENALTY_RENAME_MINUTES = 10;
const PENALTY_AUTO_MUTE_MINUTES = 5;
const PENALTY_SETTLEMENT_SECONDS = 60;
const SURRENDER_MUTE_MINUTES = 3;
const SURRENDER_RENAME_MINUTES = 7;
const PENALTY_MUTE_REASON = '恶魔轮盘：败者惩罚';
const PENALTY_RENAME_APPLY_REASON = '恶魔轮盘：败者强制改名';
const PENALTY_RENAME_RESTORE_REASON = '恶魔轮盘：改名惩罚到期，恢复原昵称';
const PENALTY_RENAME_ENFORCE_REASON = '恶魔轮盘：败者强制改名';
const RENAME_LOCK_TYPE = 'devil_roulette_rename';
const RENAME_MODAL_PREFIX = 'mystery_devil_roulette_rename_modal';

// 按钮配色语义：红=开枪/伤害；蓝=情报/查看；绿=治疗/恢复；灰=膛内工具/被动提示。
const ITEM_BUTTON_STYLE = {
    cigarette: 'success',
    medicine: 'success',
    magnifier: 'primary',
    phone: 'primary',
    beer: 'secondary',
    inverter: 'secondary',
    saw: 'danger',
    handcuffs: 'danger',
    adrenaline: 'secondary',
};

const STYLE_MAP = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
};

// 风味文案：短、面无表情、带点荒诞。
const FLAVOR = {
    miss: [
        '……没响。',
        '空弹。',
        '它很安静。',
        '这次不是它。',
        '枪只发出空响。',
        '击针落了个空。',
        '这一发，命运提前走了。',
        '弹巢里安静得能听见心跳。',
        '扳机扣下，房间里只有呼吸声。',
        '运气站在了枪口这一边。',
        '空弹滚出来，像一声叹息。',
    ],
    hit: [
        '砰。',
        '响了。',
        '……中了。',
        '弹孔没有偏。',
        '它这一枪没有失手。',
        '声音在房间里停留了一会儿。',
        '枪说了算。',
        '这一发等这一刻很久了。',
        '血是热的，枪是冷的。',
    ],
    self_hit: [
        '它咬的是自己。',
        '枪口对着自己，这次它没客气。',
        '镜子碎了，血是自己的。',
        '它向自己证明了一件事。',
        '赌错了，代价自己付。',
        '枪没有同情，包括对自己。',
    ],
    reload: [
        '弹壳用完了，重新装填。',
        '它又塞进去几发。',
        '弹巢重新转了起来。',
        '它给枪换了口气。',
        '又一轮，命运被重新洗牌。',
        '桌上的弹壳被扫走，新的故事装了进来。',
        '没有人知道下一发是什么。',
    ],
    game_end: [
        '最后站着的人，拿着钱离开。',
        '门开了，外面是夜。',
        '枪放下了。尘埃也放下了。',
        '赢家收拾桌面，输家收拾自己。',
        '桌子还在，人少了一个。',
        '这场赌局，到此为止。',
    ],
    saw: [
        '锯子咬过，这一枪更狠。',
        '它把伤口撕得更开。',
        '下一位客人会记住这把锯。',
        '子弹经过锯过的枪管，变得更急了。',
        '锯齿的代价，是双倍的。',
    ],
    beer: [
        '啤酒顶开了一发。',
        '它把危险的子弹吐了出来。',
        '咔嗒，一枚弹壳滚落。',
        '子弹掉在桌上，还带着余温。',
        '泡沫散了，子弹出来了。',
    ],
    handcuff: [
        '手铐锁上了。',
        '下一回合，对方动弹不得。',
        '锁链声很轻。',
        '它的对手被固定在椅子上。',
        '手腕上的金属，比枪口更安静。',
    ],
    heal: [
        '烟把命续了回来。',
        '它重新有了力气。',
        '血的颜色回来了。',
        '它又看了一眼自己的手。',
        '一口烟，换一寸血。',
    ],
    surrender: [
        '它放下枪，走出了门。',
        '子弹没有输，是心先认了输。',
        '它比谁都想活着。',
        '枪还在桌上，人已经离席。',
        '勇气用完了，但命还在。',
        '它把枪还给命运，转身离开。',
        '认输不丢命，这是今晚最划算的交易。',
    ],
};

const EXPIRED_MESSAGE = '这局已经结束了。';
const NOT_YOUR_TURN_MESSAGE = '现在还没轮到你。';
const ACT_FAILED_MESSAGE = '操作失败，请重试或刷新面板。';

// ── 基础工具 ──────────────────────────────────────────────────────────────────

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryDevilRoulette] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function mention(userId) {
    if (userId == null) return '（无人）';
    return `<@${userId}>`;
}

function pickRandom(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
}

function flavor(kind) {
    return pickRandom(FLAVOR[kind] || []);
}

function percent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function riskLabel(probability) {
    if (probability <= 0.0) return '必空弹';
    if (probability >= 1.0) return '必实弹';
    if (probability < 0.34) return '低风险';
    if (probability < 0.60) return '中风险';
    if (probability < 0.80) return '高风险';
    return '极高风险';
}

// ── 网络健壮性工具 ────────────────────────────────────────────────────────────

async function deferComponent(interaction, { ephemeral }) {
    if (!interaction || interaction.replied || interaction.deferred) return true;
    try {
        if (ephemeral) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            interaction._ephemeralDeferred = true;
        } else {
            await interaction.deferUpdate();
        }
        return true;
    } catch (error) {
        logDiscordFailure(null, 'defer-component', error, interaction.user?.id);
        return false;
    }
}

function scheduleEphemeralDelete(message, delayMs = EPHEMERAL_TTL_MS) {
    if (!message || typeof message.delete !== 'function') return;
    const t = setTimeout(() => {
        message.delete().catch(() => {});
    }, delayMs);
    t.unref?.();
}

async function sendEphemeral(interaction, payload) {
    if (!interaction) return false;
    try {
        let message = null;
        if (interaction._ephemeralDeferred && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
            message = await interaction.fetchReply?.() || null;
        } else if ((interaction.deferred || interaction.replied) && typeof interaction.followUp === 'function') {
            message = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            message = await interaction.fetchReply?.() || null;
        }
        if (message) scheduleEphemeralDelete(message);
        return Boolean(message);
    } catch (error) {
        logDiscordFailure(null, 'ephemeral-reply', error, interaction.user?.id);
        return false;
    }
}

async function sendComponentError(interaction, content) {
    return sendEphemeral(interaction, { content });
}

async function confirmComponent(interaction, content) {
    return sendEphemeral(interaction, { content });
}

// ── 会话 ──────────────────────────────────────────────────────────────────────

class DevilRouletteGame {
    constructor({
        mode,
        initiatorId,
        channel,
        guild,
        targetId = null,
        rng = null,
    }) {
        this.type = 'devil_roulette';
        this.id = randomUUID().toString().replace(/-/g, '').slice(0, 12);
        this.mode = mode;
        this.initiatorId = initiatorId;
        this.targetId = targetId;
        this.channel = channel;
        this.guild = guild;
        this.guildId = guild?.id || null;
        this.channelId = channel?.id || null;
        this.participants = [initiatorId];
        if (targetId != null) this.participants.push(targetId);
        this.participantIds = [...this.participants];

        this.status = 'challenge';
        this.state = null;
        this.rng = rng || null;

        this.panels = [];
        this.timers = new Set();
        this.turnTimer = null;
        this.lastEvent = '';
        this.finalWinnerId = null;
        this.penaltyPending = false;
        this.penaltyApplied = false;
        // 结算自动施罚定时器是否已武装（防刷新无限重置）。
        this.settlementArmed = false;
        // 主交互面板是否已建立。
        this.mainPanelSent = false;
        // 断连接续标记：restore 恢复回来的首张主面板标题带「断连接续」提醒，下次新发面板时清除。
        this.resumed = false;
        // 连续「打自己空弹保回合」合并面板：同一开枪回合原地编辑新增（同道具聚合），避免连续空枪刷屏。
        this.selfShotPanel = null;
        this.selfShotBlocks = [];
        // 惩罚口径：normal（正常终局，禁言5/改名10）或 surrender（认输，禁言3/改名7）。
        this.penaltyScope = 'normal';
        // 已用 <@id> 提示过的行动者（用于回合切换只 ping 一次）。
        this.announcedPlayer = null;
        // 本次新面板是否处于回合切换（决定 allowed_mentions 是否 ping 当前行动者）。
        this.pingCurrentTurn = false;
        // 「道具使用」面板内容：同一开枪回合内逐块累积。
        this.itemUsageLog = [];
        // 当前开枪回合的「道具使用」面板。
        this.itemPanelEntry = null;
        // 面板颜色随上一动作变化。
        this.panelColor = 0xE67E22;
        this.released = false;
    }

    // ── 派生 ──

    get title() {
        return '😈 恶魔轮盘';
    }

    shortName(userId) {
        return mention(userId);
    }

    plainName(userId) {
        const member = this.guild?.members?.cache?.get(userId);
        const name = member?.displayName;
        if (name) return name;
        // 缓存未命中（如重启续接后没预取到）：后台补拉成员进缓存，下次渲染恢复正常昵称。
        this.guild?.members?.fetch?.(userId)?.catch?.(() => {});
        return `玩家${userId}`;
    }

    modeText() {
        // 当前规则：一局定胜负（血量 4 / 弹巢 5-8 发）。
        return '一局定胜负';
    }

    openingEvent() {
        const current = this.state?.currentPlayerId;
        if (current == null) return '';
        return `🎲 随机先手：**${this.shortName(current)}**。`;
    }

    // ── 断连接续 ──

    serializeGame() {
        return {
            v: 1,
            id: this.id,
            guildId: this.guildId,
            channelId: this.channelId,
            mode: this.mode,
            initiatorId: this.initiatorId,
            targetId: this.targetId,
            participants: this.participants,
            status: this.status,
            lastEvent: this.lastEvent,
            panelColor: this.panelColor,
            finalWinnerId: this.finalWinnerId,
            penaltyPending: this.penaltyPending,
            penaltyApplied: this.penaltyApplied,
            penaltyScope: this.penaltyScope,
            panelIds: this.panels.map(entry => entry?.message?.id).filter(Boolean),
            state: this.state ? this.state.serialize() : null,
        };
    }

    persistNow() {
        // 对局快照落盘（断连接续）。写操作内部串行排队，异步完成，不阻塞渲染。
        if (this.released) return;
        try {
            resumeStore.save(this.id, this.serializeGame());
        } catch (error) {
            logDiscordFailure(this, 'resume-persist', error);
        }
    }

    deletePersisted() {
        try {
            resumeStore.remove(this.id);
        } catch (error) {
            logDiscordFailure(this, 'resume-delete', error);
        }
    }

    // 从快照重建对局实例（保留原 gameId，旧面板按钮仍能命中）。
    static restore(snapshot, { guild, channel }) {
        const game = new DevilRouletteGame({
            mode: snapshot.mode,
            initiatorId: snapshot.initiatorId,
            channel,
            guild,
            targetId: snapshot.targetId || null,
        });
        game.id = snapshot.id;
        game.status = snapshot.status;
        game.lastEvent = snapshot.lastEvent || '';
        game.panelColor = snapshot.panelColor || 0x8E44AD;
        game.finalWinnerId = snapshot.finalWinnerId || null;
        game.penaltyPending = !!snapshot.penaltyPending;
        game.penaltyApplied = !!snapshot.penaltyApplied;
        game.penaltyScope = snapshot.penaltyScope === 'surrender' ? 'surrender' : 'normal';
        game.settlementArmed = false;
        game.participants = Array.isArray(snapshot.participants) ? [...snapshot.participants] : game.participants;
        game.participantIds = [...game.participants];
        game.state = snapshot.state ? DevilState.restore(snapshot.state) : null;
        game.resumed = true; // 断连接续标记：恢复后的首张主面板标题提醒。
        return game;
    }

    // ── 生命周期 ──

    async open() {
        const ok = await this.renderLocked();
        return ok;
    }

    async acceptChallenge(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这个挑战已经结束了。';
                return;
            }
            if (interaction.user?.id === this.initiatorId) {
                rejection = '发起人不能自己应战。';
                return;
            }
            if (this.targetId != null && interaction.user?.id !== this.targetId) {
                rejection = '只有被挑战的人可以接受。';
                return;
            }
            if (interaction.user?.bot) {
                rejection = '机器人不能应战。';
                return;
            }
            const isPublic = this.targetId == null;
            // 公屏擂台：应战者第一次进来要占玩家锁，并补进参与者。
            if (isPublic) {
                if (!this.participants.includes(interaction.user.id)) {
                    if (!gameManager.addPlayer(this, interaction.user.id)) {
                        rejection = '你已经在另一场游戏里了。';
                        return;
                    }
                    this.participants.push(interaction.user.id);
                }
                this.targetId = interaction.user.id;
            }
            this.startLocked();
            this.lastEvent = `⚔️ **${this.shortName(interaction.user.id)}** ${
                isPublic ? '应战' : '接受了挑战'
            }，恶魔轮盘开始。\n${this.openingEvent()}`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这个挑战已经结束了。');
            return;
        }
        await this.sendBroadcastLocked({ title: '⚔️ 对局开始' });
        await this.renderLocked();
        try {
            // 冷却只记在发起人头上：接受者只是应约，不该被罚 30 分钟冷却。
            this.onGameStarted?.([this.initiatorId]);
        } catch (error) {
            logDiscordFailure(this, 'on-game-started', error, this.initiatorId);
        }
        await confirmComponent(interaction, '✅ 你坐进了这把椅子。恶魔轮盘，开始。');
    }

    async declineChallenge(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这个挑战已经结束了。';
                return;
            }
            if (interaction.user?.id !== this.targetId) {
                rejection = '只有被挑战的人可以拒绝。';
                return;
            }
            this.status = 'ended';
            this.lastEvent = `🏳️ **${this.shortName(interaction.user.id)}** 拒绝了挑战。`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🏳️ 你拒绝了挑战。');
    }

    async cancelByInitiator(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这局已经开始，不能取消。';
                return;
            }
            if (interaction.user?.id !== this.initiatorId) {
                rejection = '只有发起人可以取消。';
                return;
            }
            this.status = 'ended';
            this.lastEvent = '🛑 发起人取消了这局游戏。';
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🛑 你把枪收了回去，这局游戏取消。');
    }

    async act(interaction, action, expectedToken, { stealKey = null } = {}) {
        // 按钮立即完成（deferUpdate），不产生 thinking；反馈是公屏新面板。
        if (!await deferComponent(interaction, { ephemeral: false })) return;
        let result = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = EXPIRED_MESSAGE;
                return;
            }
            if (interaction.user?.id !== this.state.currentPlayerId) {
                rejection = NOT_YOUR_TURN_MESSAGE;
                return;
            }
            try {
                result = this.state.apply(action, interaction.user.id, { expectedToken, stealKey });
            } catch (error) {
                if (error instanceof InvalidAction) {
                    rejection = error.message;
                    return;
                }
                logDiscordFailure(this, 'act', error, interaction.user?.id);
                rejection = ACT_FAILED_MESSAGE;
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!result) {
            await sendComponentError(interaction, ACT_FAILED_MESSAGE);
            return;
        }
        await this.afterActionLocked(result);
        if (result.reveal) {
            await this.sendPrivateIntel(interaction);
        }
    }

    async showPrivateState(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let embed = null;
        await gameManager.runExclusive(this, () => {
            if (!this.state || !['playing', 'ended'].includes(this.status)) {
                rejection = '这局还没有可查看的私有情报。';
                return;
            }
            if (!this.state.players.includes(interaction.user?.id)) {
                rejection = '私有情报只属于本局玩家。';
                return;
            }
            embed = this.privateEmbed(interaction.user.id);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await sendEphemeral(interaction, {
            embeds: [embed],
            components: this.privateIntelRefreshRows(),
        });
    }

    // 游戏规则（仅自己可见）。挑战面板的「📖 游戏规则」按钮与局内按钮共用同一弹窗。
    rulesEmbed() {
        const cfg = GAME_CONFIG;
        const [lo, hi] = cfg.shells;
        return new EmbedBuilder()
            .setTitle('📖 游戏规则')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · 仅你可见` })
            .setDescription(
                '**🔫 对局**\n'
                + `每人 **${cfg.hp}** 点血，弹巢 ${lo}-${hi} 发（实弹占 40%-60%），一局定胜负——`
                + '先把对方血量打到 **0** 的一方获胜。\n'
                + '实弹与空弹随机排列，开枪前不知道当前这发是实是空：\n'
                + '　• **💀 打自己**：空弹不扣血并**保住回合**，实弹扣自己 1 血；\n'
                + '　• **🔫 打对手**：实弹扣对方 1 血，空弹把回合交给对方。\n'
                + '弹巢打空会重新装填并给双方补道具，新弹巢的先手**强制轮换**。\n\n'
                + '**🎁 道具**（开局发 2-3 件，同时上限 4 件，使用不消耗回合，轮到你时可先用再开枪）\n'
                + '🔍 放大镜——查看当前这发是实弹还是空弹；\n'
                + '📱 手机——预知往后某一发（只剩 1 发时不可用）；\n'
                + '🪚 手锯——下一发实弹伤害翻倍（打自己同样翻倍）；\n'
                + '🔗 手铐——对手下一回合被跳过（只剩 1 发时不可用；弹巢重装时未生效的铐直接作废）；\n'
                + '🍺 啤酒——弹出膛内子弹，弹型公开（只剩 1 发时使用会结束回合）；\n'
                + '🔄 逆转器——把膛内当前子弹翻转为相反类型（实↔空）；\n'
                + '💉 肾上腺素——偷走对手一件道具并立即使用；\n'
                + '🚬 香烟——回复 1 血；\n'
                + '💊 过期药——40% 回 2 血，否则扣 1 血。\n\n'
                + '**⏱ 回合与情报**：每回合 60 秒，超时自动开枪；'
                + '🔍/📱 探到的弹位仅自己可见（点「📜 我的情报」回看）。\n\n'
                + '**🔨 败者惩罚**：胜者选择 🔇 禁言 5 分或 ✏️ 改名 10 分'
                + `（${PENALTY_SETTLEMENT_SECONDS} 秒不选则自动禁言 5 分）；中途认输（3 血以上可用）减轻为 3 / 7 分。\n\n`
                + '**⚠️ 与原版 Buckshot Roulette 的差异**（玩过原版的请留意）：\n'
                + '　• **交替先手**：弹巢打空重新装填后，先手**强制轮换**为上一弹巢先手的对方；\n'
                + '　• **重装时未生效的手铐作废**：你给对手上了手铐但还没轮到他跳过时，'
                + '若弹巢恰好打空重装，这副手铐**直接作废**——不会延续到新弹巢；\n'
                + '　• **手铐/手机剩一发禁用**：弹巢只剩最后一发时两者均不可用；\n'
                + '　• **手机只探未探弹位**：连续使用不会重复探测已知位置（原版可能空转）；\n'
                + '　• **道具发放上限**：平衡性调整——强控类（手锯/手铐/肾上腺素）合计至多 1 件、'
                + '回复类（香烟/过期药）合计至多 1 件（原版无组上限）；\n'
                + '　• **补弹道具叠加**：重新装填时在当前持有上**再补** 2-3 件（原版重置为固定数量）；\n'
                + '　• **过期药 40%**：成功率 40%（原版 50%）。'
            );
    }

    async showItemHelp(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        await sendEphemeral(interaction, {
            embeds: [this.rulesEmbed()],
            components: this.privateIntelViewRows(interaction.user?.id),
        });
    }

    async hintCurrentTurn(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let hint = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            if (!state || this.status !== 'playing') {
                rejection = '这局还没有开始或已经结束了。';
                return;
            }
            const current = state.currentPlayerId;
            if (current == null) {
                rejection = '还没有当前行动者。';
                return;
            }
            if (interaction.user?.id === current) {
                hint = `✅ 现在是你的回合，请在 ⏱ ${TURN_SECONDS + GRACE_SECONDS} 秒内行动：\n`
                    + '　🔫 **打对手** —— 实弹命中扣对方 1 血，空弹白白送回合；\n'
                    + '　💀 **打自己** —— 空弹保住回合，实弹自己挨枪；\n'
                    + '　🎁 道具按钮、📜 我的情报都在下方，按需使用。';
            } else {
                hint = `⏳ 现在轮到 **${this.plainName(current)}**，`
                    + '请等待 TA 行动；轮到你时会自动切换面板。';
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await sendEphemeral(interaction, { content: hint });
    }

    async sendPrivateIntel(interaction) {
        let embed = null;
        await gameManager.runExclusive(this, () => {
            if (!this.state || !this.state.players.includes(interaction.user?.id)) return;
            embed = this.privateEmbed(interaction.user.id);
        });
        if (embed) {
            await sendEphemeral(interaction, {
                embeds: [embed],
                components: this.privateIntelRefreshRows(),
            });
        }
    }

    // 道具"被禁用"按钮点击：解释为什么不可用（仅自己可见）。
    // customId 尾参=道具 key（渲染时写入，状态变化也不会错位）。
    // 手机：只剩一发时实弹/空弹数在面板上明摆着，无从剧透——文案走荒诞俏皮调子，
    // 顺带说明手机机制：只能探测「往后」的未来弹位。
    // 手铐：只剩一发时马上重洗弹巢，铐不出有意义的"下一回合"。
    async showItemBlocked(interaction, itemKeyArg) {
        await deferComponent(interaction, { ephemeral: true });
        if (String(itemKeyArg) === 'handcuffs') {
            await sendComponentError(
                interaction,
                '🔗 只剩最后一发——弹巢马上重洗，铐不住任何「下一回合」。\n（手铐要在弹巢还有余量时才能锁住对手的行动，留到新弹巢再用。）'
            );
            return;
        }
        await sendComponentError(
            interaction,
            '📱 只剩最后一发——是什么子弹，弹巢已经不打自招。\n（手机只能探测「往后」的未来弹位，此刻已无未来可探。）'
        );
    }

    // 「📜 我的情报」附带的「🔄 刷新当前面板」：强制重渲染当前主面板。
    // 面板按钮异常/缺失时的恢复手段——点击后发一张带最新状态与按钮的新面板。
    privateIntelRefreshRows() {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_refresh:${this.id}`)
                .setLabel('🔄 刷新当前面板')
                .setStyle(ButtonStyle.Secondary)
        );
        return [row];
    }

    async refreshPanel(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let allowed = false;
        await gameManager.runExclusive(this, () => {
            if (['playing', 'ended'].includes(this.status) && this.state) allowed = true;
        });
        if (!allowed) {
            await sendComponentError(interaction, '这局还没有可刷新的活动面板。');
            return;
        }
        // 强制重渲染当前面板（人类回合会带上开枪按钮；旧面板按钮被禁用）。
        const ok = await this.renderLocked();
        await sendEphemeral(interaction, {
            content: ok ? '🔄 已刷新当前面板。' : '🔄 面板刷新失败，请稍后再试。',
        });
    }

    async surrender(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        let loserId = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = '这局还没开始或已经结束了。';
                return;
            }
            if (!this.state.players.includes(interaction.user?.id)) {
                rejection = '只有对局里的玩家可以认输。';
                return;
            }
            if ((this.state.hp[interaction.user.id] || 0) <= SURRENDER_MIN_HP) {
                rejection = `血量仅剩 ${SURRENDER_MIN_HP} 点，这一枪必须打完。`;
                return;
            }
            loserId = interaction.user.id;
            this.status = 'ended';
            this.finalWinnerId = this.state.other(loserId);
            this.penaltyScope = 'surrender';
            this.panelColor = 0x8E44AD;
            this.lastEvent = `🏳️ **${this.shortName(loserId)}** 认输了。\n${flavor('surrender')}`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这局还没开始或已经结束了。');
            return;
        }
        this.onGameEndedLocked(); // 与正常终局同路：置位 penaltyPending（惩罚按钮 + 60s 自动施罚）
        await this.renderLocked();
        await confirmComponent(interaction, '🏳️ 你放下了枪。命还在，就是赢了另一半。');
    }

    onGameEndedLocked() {
        // 终局统一处理：胜者自选惩罚。
        if (!this.state || this.finalWinnerId == null) return;
        this.penaltyPending = true;
    }

    armSettlementTimeoutLocked() {
        // 幂等：胜者超时未选才自动禁言。刷新面板/重渲染会重复调用——
        // 若每次都重置，败者可用「🔄 刷新」无限拖延自动施罚。只武装一次。
        if (this.settlementArmed) return;
        this.settlementArmed = true;
        this.cancelTimerLocked();
        this.turnTimer = this.schedule(
            () => this.settlementTimeout().catch(error => logDiscordFailure(this, 'settlement-timeout', error)),
            PENALTY_SETTLEMENT_SECONDS * 1000
        );
    }

    async settlementTimeout() {
        let act = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'ended' || this.penaltyApplied || !this.penaltyPending) return;
            act = true;
        });
        if (act) await this.autoPenaltyLocked();
    }

    async autoPenaltyLocked() {
        // 胜者超时未选择：自动禁言输家 5 分钟。
        const state = this.state;
        const winnerId = this.finalWinnerId;
        if (!state || winnerId == null) return;
        let proceed = false;
        // 在临界区内「认领」惩罚（先置位再做网络 I/O），否则与胜者手点 finalizePenalty 竞态，
        // 双方都通过检查 → 输家被同时禁言+改名。
        await gameManager.runExclusive(this, () => {
            if (this.penaltyApplied || !this.penaltyPending) return;
            this.penaltyApplied = true;
            this.penaltyPending = false;
            proceed = true;
        });
        if (!proceed) return;
        const loserId = state.other(winnerId);
        const [ok, line, retryable] = await this.applyPenaltyAndNarrate(loserId, 'mute', {
            minutes: PENALTY_AUTO_MUTE_MINUTES,
        });
        if (!ok && retryable) {
            // 可重试失败：放开认领让胜者还能手点（按钮保留）。
            await gameManager.runExclusive(this, () => {
                if (this.status === 'ended' && this.penaltyApplied) {
                    this.penaltyApplied = false;
                    this.penaltyPending = true;
                }
            });
            this.lastEvent += `\n${line}（胜者未在 ${PENALTY_SETTLEMENT_SECONDS} 秒内选择，自动施罚失败——胜者仍可手动重试）`;
        } else {
            // 成功，或不可重试（权限不足——重试无意义）：维持终局，按钮不再出现。
            this.lastEvent += `\n${line}（胜者未在 ${PENALTY_SETTLEMENT_SECONDS} 秒内选择，自动施罚）`;
        }
        await this.renderLocked();
    }

    async applyPenaltyAndNarrate(loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        let ok = false;
        let message = '';
        let retryable = false;
        try {
            [ok, message, retryable] = await this.applyPenalty(this.guild, loserId, penaltyType, { nickname, minutes });
        } catch (error) {
            logDiscordFailure(this, 'penalty', error, loserId);
            ok = false;
            message = '惩罚调用异常（网络或内部错误）';
            retryable = true;
        }
        if (ok) return [true, `🔒 败者 **${this.shortName(loserId)}**：${message}`, false];
        return [false, `⚠️ 败者 **${this.shortName(loserId)}** 惩罚未生效：${message}`, retryable];
    }

    async finalizePenalty(interaction, penaltyType, nickname) {
        // 胜者点击惩罚按钮后执行（PvP）。网络 I/O + 面板刷新，异常不抛出。
        const deferred = await deferComponent(interaction, { ephemeral: true });
        // 交互无法确认（超 3s 或 Discord 拒收）→ 不施罚，避免静默生效且胜者无反馈。
        if (!deferred) return;
        let rejection = null;
        let ok = false;
        let loserId = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            const winnerId = this.finalWinnerId;
            if (this.status !== 'ended' || !state || winnerId == null) {
                rejection = '这局已经结束。';
                return;
            }
            if (this.penaltyApplied) {
                rejection = '败者惩罚已经处理过了。';
                return;
            }
            if (interaction.user?.id !== winnerId) {
                rejection = '只有胜利者可以决定败者的惩罚。';
                return;
            }
            // 临界区内认领惩罚，避免与 settlementTimeout 自动禁言竞态（同局被禁言+改名）。
            this.penaltyApplied = true;
            this.penaltyPending = false;
            loserId = state.other(winnerId);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (loserId == null) {
            await sendComponentError(interaction, '这局已经结束。');
            return;
        }
        const [muteMin, renameMin] = this.penaltyMinutes();
        const minutes = penaltyType === 'mute' ? muteMin : renameMin;
        let line = null;
        let retryable = false;
        [ok, line, retryable] = await this.applyPenaltyAndNarrate(loserId, penaltyType, { nickname, minutes });
        if (!ok) {
            if (retryable) {
                // 可重试失败（网络抖动等）：放开认领，让自动禁言兜底或胜者重试，避免输家逃罚。
                await gameManager.runExclusive(this, () => {
                    if (this.status === 'ended' && this.penaltyApplied) {
                        this.penaltyApplied = false;
                        this.penaltyPending = true;
                    }
                });
            }
            // 不可重试（权限不足等）：保持认领——按钮不再出现，60s 自动施罚也已跳过，
            // 避免胜者反复点击反复失败刷屏。失败原因已写进结算叙述。
        }
        // 惩罚结果拼进叙述（last_event += line，结算面板可见）。
        if (line) this.lastEvent += `\n${line}`;
        await this.renderLocked();
        await sendEphemeral(
            interaction,
            {
                content: ok ? '✅ 败者惩罚已施加。'
                    : retryable ? '❌ 败者惩罚未能施加（网络问题），可稍后重试。'
                    : '❌ 败者惩罚无法施加（权限不足）——原因已写在结算面板，本局不再提供惩罚选项。',
            }
        );
    }

    async chooseMutePenalty(interaction) {
        await this.finalizePenalty(interaction, 'mute', null);
    }

    async chooseRenamePenalty(interaction, nickname) {
        await this.finalizePenalty(interaction, 'rename', nickname);
    }

    async openRenameModal(interaction) {
        // 改名按钮：校验胜者后弹出昵称输入对话框。
        // 纯读取校验不走 runExclusive——那是慢路径，交互超 3s 未响应会被 Discord 丢弃 Modal。
        // 真正变更在提交时 finalizePenalty 内再上锁复检（此处读到的是瞬间快照，竞态由复检兜底）。
        const state = this.state;
        const winnerId = this.finalWinnerId;
        if (this.status !== 'ended' || !state || winnerId == null) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '这局已经结束。');
            return;
        }
        if (this.penaltyApplied) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '败者惩罚已经处理过了。');
            return;
        }
        if (interaction.user?.id !== winnerId) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '只有胜利者可以决定败者的惩罚。');
            return;
        }
        const input = new TextInputBuilder()
            .setCustomId('devil_roulette_rename_input')
            .setLabel('要给败者改成的昵称（最多 32 字）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
            .setPlaceholder('例如：🔒 恶魔轮盘输家');
        const modal = new ModalBuilder()
            .setCustomId(`${RENAME_MODAL_PREFIX}:${this.id}`)
            .setTitle('✏️ 败者改名惩罚')
            .addComponents(new ActionRowBuilder().addComponents(input));
        try {
            await interaction.showModal(modal);
        } catch (error) {
            logDiscordFailure(this, 'show-rename-modal', error, interaction.user?.id);
        }
    }

    // ── 定时器 ──

    schedule(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, Math.min(ms, 2 ** 31 - 1));
        t.unref?.();
        this.timers.add(t);
        return t;
    }

    cancelTimerLocked() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.timers.delete(this.turnTimer);
            this.turnTimer = null;
        }
    }

    async challengeTimeout() {
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') return;
            this.status = 'ended';
            this.lastEvent = '⌛ 没有人敢碰那把枪。挑战超时，面板已失效。';
            changed = true;
        });
        if (changed) await this.renderLocked();
    }

    // 回合超时：直接替当前玩家开一枪（主延迟由定时器承担，含 2s 宽限）。
    async turnTimeout(armedToken) {
        let result = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) return;
            if (this.state.turnToken !== armedToken) return;
            try {
                result = this.state.apply('shoot_opponent', this.state.currentPlayerId, { expectedToken: armedToken });
            } catch (error) {
                if (!(error instanceof InvalidAction)) throw error;
            }
        });
        if (result) await this.afterActionLocked(result);
        else await this.armTimerLocked();
    }

    startLocked() {
        this.status = 'playing';
        this.state = new DevilState(this.participants, {
            rng: this.rng || defaultRng(),
            alternateFirstTurn: this.mode === 'pvp',
        });
    }

    armTimerLocked() {
        this.cancelTimerLocked();
        if (this.status === 'challenge') {
            this.turnTimer = this.schedule(
                () => this.challengeTimeout().catch(error => logDiscordFailure(this, 'challenge-timeout', error)),
                CHALLENGE_SECONDS * 1000
            );
        } else if (this.status === 'playing' && this.state) {
            const token = this.state.turnToken;
            this.turnTimer = this.schedule(
                () => this.turnTimeout(token).catch(error => logDiscordFailure(this, 'turn-timeout', error)),
                (TURN_SECONDS + GRACE_SECONDS) * 1000
            );
        }
    }

    // ── 渲染 ──

    ensureReleased() {
        // 终局但胜者还没选惩罚（结算待定）：暂不释放，惩罚落定后再释放。
        if (this.status === 'ended' && this.penaltyPending && !this.penaltyApplied) return;
        if (this.released) return;
        this.released = true;
        this.disableAllComponents();
        this.settlementArmed = false;
        this.deletePersisted();
        return gameManager.cleanupGame(this);
    }

    teardownNoSend() {
        this.status = 'ended';
        this.cancelTimerLocked();
        this.ensureReleased();
    }

    async afterActionLocked(result) {
        // 动作提交后的统一分流：终局→结算面板；道具→道具面板+主面板同步；开枪→播报+新面板。
        this.lastEvent = this.safeFormatResult(result);
        this.panelColor = this.resultColor(result);
        const boundary = result.action === 'shoot_self'
            || result.action === 'shoot_opponent'
            || result.reloaded
            || result.roundEnded;
        if (result.gameEnded) {
            this.resetItemPanel();
            this.status = 'ended';
            this.finalWinnerId = result.gameWinnerId;
            await this.onGameEndedLocked();
            await this.renderLocked();
        } else if (result.action in ITEM_DEFS) {
            // 道具使用：记录进「道具使用」面板（同一开枪回合内编辑更新）+ 主面板同步道具数。
            this.recordItemUse(result);
            await this.publishItemPanelLocked(result);
            await this.renderItemUseLocked();
            if (boundary) this.resetItemPanel();
        } else {
            // 开枪分流：空枪打自己 → 连击面板 + 主面板原地刷新；其余 → 播报面板 + 新主面板。
            const selfBlank = result.action === 'shoot_self' && !result.hit && !result.roundEnded
                && this.state != null && this.state.currentPlayerId === result.actorId;
            if (selfBlank) {
                // 连续空枪合并进同一张连击面板。顺序固定：主面板先就位（原地编辑保位置；
                // 掉出滚动窗口就新发到最底），连击面板随后更新——**任何情况下都在主面板下方**。
                // 空枪恰好打空弹巢（reloaded）：重装通知已含在 lastEvent 里，随这发并入后断开合并。
                const n = this.selfShotBlocks.length + 1;
                this.selfShotBlocks.push(`**第 ${n} 发空枪**　${this.lastEvent}`);
                await this.refreshMainPanelLocked();
                await this.updateSelfShotComboLocked();
                if (result.reloaded) {
                    this.selfShotBlocks = [];
                    this.selfShotPanel = null;
                }
            } else {
                this.selfShotBlocks = [];
                this.selfShotPanel = null;
                if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
                    await this.sendBroadcastLocked({ title: this.broadcastTitle(result) });
                }
                await this.renderLocked();
            }
            if (boundary) this.resetItemPanel();
        }
    }

    selfShotComboEmbed() {
        // 连击面板：author=游戏名，标题带连击数，正文=逐发叙述块。
        const n = this.selfShotBlocks.length;
        let desc = this.selfShotBlocks.join('\n\n');
        if (this.state) {
            desc += `\n\n**🔫 枪里还剩 ${this.state.totalRemaining} 发**　实弹 ${this.state.liveRemaining} · 空弹 ${this.state.blankRemaining}`;
        }
        return new EmbedBuilder()
            .setAuthor({ name: `${this.title} · ${this.modeText()}` })
            .setColor(this.panelColor)
            .setTitle(`😮‍💨 空枪连击 · 共 ${n} 发`)
            .setDescription(desc)
            .setFooter({ text: '连续打自己空枪保住回合 · 开枪/换手后刷新' });
    }

    // 空枪连击面板：**任何情况下都保证在主面板下方**（即频道最底）。
    // 调用前主面板已就位（原地编辑保位置，或新发到最底）。连击面板已是
    // 滚动窗口最后一条 → 原地编辑新增；位置被后续面板顶掉（或编辑失败）→
    // 删掉旧连击面板、重新发到最底——不留上面的旧副本。
    async updateSelfShotComboLocked() {
        if (!this.selfShotBlocks.length || typeof this.channel?.send !== 'function') return;
        const embed = this.selfShotComboEmbed();
        const entry = this.selfShotPanel;
        if (entry != null) {
            const isLast = this.panels.length > 0 && this.panels[this.panels.length - 1] === entry;
            if (isLast) {
                try {
                    await entry.message.edit({
                        embeds: [embed],
                        allowedMentions: { parse: [], users: [], repliedUser: false },
                    });
                    return;
                } catch (error) {
                    logDiscordFailure(this, 'selfshot-panel-edit', error);
                }
            }
            // 旧面板不在最底（或已失效）：删旧重发，保证紧跟主面板下方。
            this.selfShotPanel = null;
            this.panels = this.panels.filter(e => e !== entry);
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'selfshot-panel-delete', error);
            }
        }
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'selfshot-panel-send', error);
            return;
        }
        const comboEntry = { message, interactive: false };
        this.selfShotPanel = comboEntry;
        this.panels.push(comboEntry);
        await this.pruneWindowLocked();
    }

    broadcastTitle(result) {
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            if (result.hit) return pickRandom(['💥 实弹命中！', '🔫 正中靶心', '💀 一枪见血', '🩸 弹不虚发', '⚡ 该响的时候响了']);
            return pickRandom(['😮‍💨 空枪……', '💨 打空了', '🤷 没响，有点尴尬', '🍃 与死神擦肩', '😶 虚惊一场']);
        }
        if (result.reloaded) return '🔁 重新装填';
        return '🎲 恶魔轮盘';
    }

    async sendBroadcastLocked({ title }) {
        // 把 last_event 的叙述单独发成一张「播报面板」：计入滚动窗口、无按钮、不 ping。
        if (!this.lastEvent) return;
        if (typeof this.channel?.send !== 'function') return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` })
            .setDescription(this.lastEvent);
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'broadcast', error);
            return;
        }
        this.panels.push({ message, interactive: false });
        await this.pruneWindowLocked();
    }

    async disablePreviousButtonsLocked() {
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            try {
                await entry.message.edit({
                    components: [],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
            } catch (error) {
                logDiscordFailure(this, 'disable-previous-buttons', error);
            }
        }
    }

    async pruneWindowLocked() {
        while (this.panels.length > PANEL_HISTORY_LIMIT) {
            const entry = this.panels.shift();
            if (entry === this.itemPanelEntry) this.itemPanelEntry = null;
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-window', error);
            }
        }
    }

    async pruneToFinalLocked(keep) {
        const doomed = this.panels.filter(entry => entry !== keep);
        this.panels = [keep];
        for (const entry of doomed) {
            if (entry === this.itemPanelEntry) this.itemPanelEntry = null;
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-to-final', error);
            }
        }
    }

    buildPanel() {
        if (this.status === 'challenge') {
            return { embed: this.challengeEmbed(), rows: this.challengeViewRows(), interactive: true };
        }
        if (this.status === 'playing' && this.state) {
            return { embed: this.playEmbed(), rows: this.gameViewRows(), interactive: true };
        }
        const rows = this.settlementViewRows();
        return { embed: this.settlementEmbed(), rows, interactive: rows.length > 0 };
    }

    async renderLocked({ armTimer = true } = {}) {
        // 断连接续：每次渲染前把当前对局状态落盘（renderLocked 是「状态变更后」的集中出口）。
        this.persistNow();
        const first = this.panels.length === 0;
        // 道具面板不在此重置：它跟「开枪回合」生命周期走。
        this.pingCurrentTurn = false;
        let entry = null;
        try {
            const { embed, rows, interactive } = this.buildPanel();
            // 软兜底：人类回合面板绝不能没按钮——空行强制换成最小可用按钮集。
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.status === 'playing' && this.state && current != null) {
                if (!rows.length) {
                    logDiscordFailure(this, 'rows-fallback', new Error(`human turn got empty rows (rows=${rows.length})`), current);
                    finalRows = this.guaranteedTurnRows(this.state);
                }
            }
            const message = await this.channel.send({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry = { message, interactive };
        } catch (error) {
            logDiscordFailure(this, 'render', error);
            // 软兜底：发送失败（如组件被 Discord 拒绝）时，用最小可用按钮集重试一次，
            // 保证人类回合面板永远弹得出（guaranteedTurnRows 的 customId 恒唯一，不会重蹈 50035）。
            if (this.status === 'playing' && this.state && this.state.currentPlayerId != null && entry == null) {
                try {
                    const embed = this.playEmbed();
                    const fallbackRows = this.guaranteedTurnRows(this.state);
                    const message = await this.channel.send({
                        embeds: [embed],
                        components: fallbackRows,
                        allowedMentions: { parse: [], users: [], repliedUser: false },
                    });
                    entry = { message, interactive: true };
                } catch (error2) {
                    logDiscordFailure(this, 'render-fallback-retry', error2);
                }
                if (entry) this.mainPanelSent = true;
            }
            // 主面板从未成功建立 → 彻底收尾，避免游戏隐形空转。
            if (!this.mainPanelSent) {
                this.teardownNoSend();
                return false;
            }
            if (armTimer && ['challenge', 'playing'].includes(this.status)) {
                this.armTimerLocked();
            } else if (this.status === 'ended') {
                this.cancelTimerLocked();
                this.ensureReleased();
            }
            return true;
        }

        try {
            if (!first) await this.disablePreviousButtonsLocked();
            this.panels.push(entry);
            this.mainPanelSent = true;
            // 面板已入列：再落盘一次，让快照 panelIds 包含刚发出的这张（开头那次 persist 在
            // 发送前、不含它）。否则非优雅退出时恢复兜底按 panelIds 删旧面板会漏掉当前主面板，
            // 频道里留下仍可点击的旧面板。
            this.persistNow();
            if (['challenge', 'playing'].includes(this.status)) {
                await this.pruneWindowLocked();
                if (armTimer) this.armTimerLocked();
            } else {
                this.cancelTimerLocked();
                await this.pruneToFinalLocked(entry);
                this.ensureReleased();
                // 结算面板挂起且胜者未选惩罚 → 启动自动施罚倒计时。
                if (this.penaltyPending && !this.penaltyApplied) {
                    this.armSettlementTimeoutLocked();
                }
            }
        } catch (error) {
            logDiscordFailure(this, 'render-cleanup', error);
            if (['challenge', 'playing'].includes(this.status)) {
                try {
                    this.armTimerLocked();
                } catch (error2) {
                    this.teardownNoSend();
                }
            } else {
                this.ensureReleased();
                // 清理抛错也不能丢了 30s 自动施罚：结算挂起且胜者未选 → 补装定时器。
                if (this.penaltyPending && !this.penaltyApplied) {
                    try {
                        this.armSettlementTimeoutLocked();
                    } catch (error2) {
                        logDiscordFailure(this, 'render-cleanup-settlement', error2);
                    }
                }
            }
        }
        return true;
    }

    async refreshMainPanelLocked() {
        // 主面板原地编辑刷新（不新发消息）：道具使用、空枪保回合复用。
        // 找不到可编辑的主面板（如从未发送/被 3 窗口挤出）时退回新发。
        // 断连接续：状态已变（空枪/道具），先落盘再编辑。
        this.persistNow();
        if (!this.panels.length || this.status !== 'playing') {
            await this.renderLocked();
            return;
        }
        try {
            const { embed, rows, interactive } = this.buildPanel();
            // 软兜底：主面板编辑也绝不落成无按钮的人类回合面板。
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.state && current != null) {
                if (!rows.length) {
                    logDiscordFailure(this, 'refresh-main-rows-fallback', new Error(`refresh edit got empty rows`), current);
                    finalRows = this.guaranteedTurnRows(this.state);
                }
            }
            // 主面板 = 最后一张交互面板（带按钮）；广播/道具面板 interactive=false 不会被选中。
            const entry = [...this.panels].reverse().find(e => e.interactive);
            if (!entry) {
                // 主面板已被连击/道具记录挤出窗口：重发一张新的到最底。
                // （连击面板的「保持在主面板下方」由调用后的 updateSelfShotComboLocked 负责。）
                await this.renderLocked();
                return;
            }
            await entry.message.edit({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry.interactive = interactive;
        } catch (error) {
            logDiscordFailure(this, 'refresh-main', error);
            await this.renderLocked();
            return;
        }
        this.armTimerLocked();
    }

    async renderItemUseLocked() {
        // 道具使用后同步编辑主面板（道具详情已进专用道具面板）——复用主面板原地刷新。
        await this.refreshMainPanelLocked();
    }

    resetItemPanel() {
        // 刷新「道具使用」面板：清内容 + 释放指针（下一次道具操作开新面板）。
        this.itemPanelEntry = null;
        this.itemUsageLog = [];
    }

    async publishItemPanelLocked(result) {
        // 发布/更新「道具使用」面板：同开枪回合首条道具 → 发新面板；后续道具 → 原地编辑。
        if (!this.itemUsageLog.length || this.status !== 'playing' || !this.state) return;
        const embed = this.itemPanelEmbed(result.actorId);
        const entry = this.itemPanelEntry;
        if (entry != null) {
            try {
                await entry.message.edit({
                    embeds: [embed],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
                return;
            } catch (error) {
                logDiscordFailure(this, 'item-panel-edit', error);
                this.itemPanelEntry = null;
            }
        }
        if (typeof this.channel?.send !== 'function') return;
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'item-panel-send', error);
            return;
        }
        const newEntry = { message, interactive: false };
        this.itemPanelEntry = newEntry;
        this.panels.push(newEntry);
        await this.pruneWindowLocked();
    }

    itemPanelEmbed(actorId) {
        const embed = new EmbedBuilder()
            .setTitle('🎁 道具使用')
            .setColor(0xE67E22)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        let desc = this.itemUsageLog.join('\n\n');
        if (this.state) desc += `\n\n**剩余道具**：${this.itemsText(actorId)}`;
        embed.setDescription(desc);
        embed.setFooter({ text: '本回合的道具操作都记在这里 · 主面板同步更新 · 开枪后翻篇' });
        return embed;
    }

    recordItemUse(result) {
        this.itemUsageLog.push(this.itemUsageBlock(result));
        if (this.itemUsageLog.length > ITEM_LOG_LIMIT) this.itemUsageLog.shift();
    }

    itemUsageBlock(result) {
        const actor = this.shortName(result.actorId);
        let head;
        if (result.itemKey === 'adrenaline') {
            const stolen = ITEM_DEFS[result.stolenKey || ''];
            const victim = this.state ? this.shortName(this.state.other(result.actorId)) : '对手';
            const stolenLabel = stolen ? `${stolen.emoji} ${stolen.name}` : '道具';
            head = `💉 肾上腺素 → 偷取 ${victim} 的 ${stolenLabel} 并立即使用`;
        } else {
            const item = ITEM_DEFS[result.itemKey || ''];
            head = item ? `${item.emoji} ${item.name}` : '道具';
        }
        const lines = [`- **${actor} 使用 ${head}**`];
        for (const ln of this.itemEffectLines(result)) lines.push(`　${ln}`);
        return lines.join('\n');
    }

    resultColor(result) {
        if (result.gameEnded || result.roundEnded) return 0x8E44AD; // 紫 — 新一轮 / 终局
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            return result.hit ? 0xE74C3C : 0x2ECC71; // 红 — 中弹 / 绿 — 空枪
        }
        return 0xE67E22; // 橙 — 道具使用等
    }

    panelMentions() {
        // 每个新面板该 ping 谁：挑战→被挑战者；回合切换→当前真人行动者；结算待选→胜者。
        const pingIds = [];
        if (this.status === 'challenge' && this.targetId != null) {
            pingIds.push(this.targetId);
        } else if (this.status === 'playing' && this.state && this.pingCurrentTurn) {
            const current = this.state.currentPlayerId;
            if (current != null) pingIds.push(current);
        } else if (this.status === 'ended' && this.penaltyPending && !this.penaltyApplied) {
            const winner = this.finalWinnerId;
            if (winner != null) pingIds.push(winner);
        }
        this.pingCurrentTurn = false;
        return { parse: [], users: pingIds, repliedUser: false };
    }

    // ── 面板文案 ──

    challengeEmbed() {
        // 游戏名放 author 小字常驻，title 用动态大标题。
        const embed = new EmbedBuilder()
            .setTitle('🔫 决斗邀请')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        const cfg = GAME_CONFIG;
        let headline;
        if (this.targetId == null) {
            headline = `**${this.shortName(this.initiatorId)}** 摆下恶魔轮盘擂台，**等待一位勇士**……`
                + `\n（${this.modeText()}）\n\n`
                + '任何成员点下方 **⚔️ 应战** 即可入局。';
        } else {
            headline = `**${this.shortName(this.initiatorId)}** 向 ${mention(this.targetId)} 发起恶魔轮盘对决`
                + `（${this.modeText()}）。\n\n`;
        }
        const deadline = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;
        const [lo, hi] = cfg.shells;
        embed.setDescription(
            `${headline}\n`
            + `每人 **${cfg.hp}** 点血，弹巢 ${lo}-${hi} 发（实弹占比 40%-60%），一局定胜负。`
            + '开枪前不知道这发是实是空：**打自己**空弹保回合 / **打对手**实弹扣血。\n'
            + `开局随机发道具，可用「${ITEM_HELP_LABEL}」随时看完整规则与道具讲解。\n\n`
            + `🔨 **败者惩罚**（胜者定）：🔇 禁言 ${PENALTY_MUTE_MINUTES} 分 / ✏️ 改名 ${PENALTY_RENAME_MINUTES} 分。\n\n`
            + `⏳ 擂台将在 <t:${deadline}:R> 后收摊。`
        );
        if (this.targetId == null) {
            embed.setFooter({ text: '谁都能上桌（发起人自己不行）；不想玩了，发起人可随时收枪取消。' });
        } else {
            embed.setFooter({ text: '枪只递给了一个人——只有 TA 能接受或拒绝；发起人可以取消。' });
        }
        return embed;
    }

    playEmbed() {
        const state = this.state;
        if (!state) {
            return new EmbedBuilder()
                .setTitle(this.title)
                .setColor(0x8E44AD)
                .setDescription(this.lastEvent || '游戏尚未开始。');
        }

        const current = state.currentPlayerId;
        // 断连接续标记：恢复回来的首张主面板标题提醒，下一次新发面板时清除。
        const resumed = this.resumed;
        if (resumed) this.resumed = false;
        const title = resumed ? '🔁 断连接续 · 🎯 开枪回合' : '🎯 开枪回合';
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });

        // 主体状态放 description，空行分节给呼吸感。
        const parts = [];

        // 回合切换的 ping 标记保留（新面板只 ping 新的行动者一次）。
        let isNewTurn = false;
        if (current != null) {
            isNewTurn = current !== this.announcedPlayer;
            if (isNewTurn) {
                this.announcedPlayer = current;
                this.pingCurrentTurn = true;
            }
        }

        // 实时倒计时：<t:deadline:R> 客户端滴答。
        if (current != null) {
            if (isNewTurn) parts.push(`⚡现在轮到${mention(current)}开枪了！`);
            parts.push(`⏳ <t:${Math.floor(Date.now() / 1000) + TURN_SECONDS + GRACE_SECONDS}:R> 自动行动`);
            parts.push('');
        }

        // 枪内状态：整行加粗 + 🔫 前缀。
        if (state.inverterObscured) {
            parts.push(`**🔫 枪内 ${state.totalRemaining} 发　实弹 ？？ · 空弹 ？？　中弹率 ？？**`);
        } else {
            const chance = state.totalRemaining ? state.liveRemaining / state.totalRemaining : 0.0;
            const risk = state.totalRemaining ? `（${riskLabel(chance)}）` : '';
            const pct = state.totalRemaining ? percent(chance) : '—';
            parts.push(
                `**🔫 枪内 ${state.totalRemaining} 发　实弹 ${state.liveRemaining} · `
                + `空弹 ${state.blankRemaining}　中弹率 ${pct}**${risk}`
            );
        }
        if (state.sawArmed) parts.push('　🪚 手锯已上膛：下一发实弹伤害翻倍。');
        parts.push('', '');

        embed.setDescription(parts.join('\n'));

        // 双方区块：整行宽字段，每人独立成块；<@id> 必须放 field.value。
        const ordered = current != null
            ? [current, ...state.players.filter(p => p !== current)]
            : state.players;
        for (let idx = 0; idx < ordered.length; idx++) {
            const playerId = ordered[idx];
            const fname = playerId === current ? '🔥 行动中' : '💤 等待';
            const lines = [
                `${mention(playerId)}　${state.hpText(playerId)}`,
                `道具：${this.itemsText(playerId)}`,
            ];
            if (state.handcuffed.has(playerId)) {
                lines.push('🔗 下一回合被铐住，跳过行动');
            }
            // 块尾一个 ZWSP 行 = 一行空行分隔下一玩家。
            if (idx < ordered.length - 1) lines.push('​');
            embed.addFields([{ name: fname, value: lines.join('\n'), inline: false }]);
        }
        return embed;
    }

    itemsText(playerId) {
        const state = this.state;
        if (!state) return '—';
        const items = state.items[playerId] || [];
        if (!items.length) return '（无）';
        const counts = new Map();
        for (const key of items) counts.set(key, (counts.get(key) || 0) + 1);
        const parts = [];
        for (const [key, n] of counts) {
            const item = ITEM_DEFS[key];
            const label = `${item.emoji} ${item.name}`;
            parts.push(n === 1 ? label : `${label}×${n}`);
        }
        return parts.join('　');
    }

    privateEmbed(userId) {
        const state = this.state;
        if (!state) throw new InvalidAction('这局还没有私有情报。');
        return new EmbedBuilder()
            .setTitle(`${this.title} · 仅你可见`)
            .setColor(0x5865F2)
            .addFields([
                { name: '⚡ 我的电量', value: state.hpText(userId), inline: true },
                { name: '🎁 我的道具', value: this.itemsText(userId), inline: true },
                { name: '📜 情报', value: state.privateIntelText(userId), inline: false },
            ]);
    }

    penaltyMinutes() {
        // 当前惩罚口径的 (禁言分钟, 改名分钟)。正常终局 5/10；认输 3/7。
        if (this.penaltyScope === 'surrender') {
            return [SURRENDER_MUTE_MINUTES, SURRENDER_RENAME_MINUTES];
        }
        return [PENALTY_MUTE_MINUTES, PENALTY_RENAME_MINUTES];
    }

    settlementEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🏆 结算')
            .setColor(0xF1C40F)
            .setAuthor({ name: this.title });
        const parts = [];
        if (this.finalWinnerId != null) {
            parts.push(`🏆 ${mention(this.finalWinnerId)} 赢下了这场恶魔轮盘。\n${flavor('game_end')}`);
        }
        if (this.lastEvent) parts.push(this.lastEvent);
        if (this.penaltyPending && !this.penaltyApplied) {
            const [muteMin, renameMin] = this.penaltyMinutes();
            parts.push(
                `🔨 **胜者，轮到你收利息了**：🔇 禁言 ${muteMin} 分钟，`
                + `或 ✏️ 改名 ${renameMin} 分钟（可自定义败者的新名字）——点下方按钮。`
                + `${PENALTY_SETTLEMENT_SECONDS} 秒内不选，桌子替你做主：`
                + `**自动禁言输家 ${PENALTY_AUTO_MUTE_MINUTES} 分钟**。`
            );
        }
        embed.setDescription(parts.join('\n\n'));
        return embed;
    }

    // ── 叙述 ──

    safeFormatResult(result) {
        try {
            return this.formatResult(result);
        } catch (error) {
            logDiscordFailure(this, 'format-result', error, result.actorId);
            return `⚠️ **${this.shortName(result.actorId)}** 的操作已完成，但事件描述生成失败。`;
        }
    }

    formatResult(result) {
        const actor = this.shortName(result.actorId);
        const lines = [];
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            const targetSelf = result.action === 'shoot_self';
            if (result.hit) {
                const dmg = result.sawDoubled ? `（手锯翻倍 ${result.damage} 点）` : '（1 点）';
                if (targetSelf) {
                    lines.push(`💥 ${actor} 开枪打自己，中弹 ${dmg}。`);
                    lines.push(flavor('self_hit'));
                } else {
                    lines.push(`💥 ${actor} 开枪命中 **${this.shortName(result.targetId)}** ${dmg}。`);
                    lines.push(flavor('hit'));
                }
            } else {
                if (targetSelf) {
                    lines.push(`😮‍💨 ${actor} 开枪打自己，空弹，保住了回合。`);
                } else {
                    lines.push(`😮‍💨 ${actor} 开枪打 **${this.shortName(result.targetId)}**，空弹。`);
                }
                lines.push(flavor('miss'));
            }
            if (result.reloaded) {
                lines.push('（弹壳用完了。枪，重新装填。）');
                lines.push(flavor('reload'));
            }
        } else if (result.action === 'adrenaline') {
            const stolen = ITEM_DEFS[result.stolenKey || ''];
            const victim = this.state ? this.shortName(this.state.other(result.actorId)) : '对手';
            const stolenLabel = stolen ? `${stolen.emoji} ${stolen.name}` : '道具';
            lines.push(`💉 ${actor} 用肾上腺素偷走了 **${victim}** 的 ${stolenLabel}，并立即使用。`);
            lines.push(...this.itemEffectLines(result));
        } else {
            const item = ITEM_DEFS[result.itemKey || ''];
            const label = item ? `${item.emoji} ${item.name}` : result.itemKey;
            lines.push(`🎁 ${actor} 使用了 ${label}。`);
            lines.push(...this.itemEffectLines(result));
        }

        if (result.roundEnded && result.killedId === result.actorId && result.itemKey) {
            lines.push('💀 那粒过期药，把赌命的人一起带走了。');
        }
        return lines.join('\n');
    }

    itemEffectLines(result) {
        const lines = [];
        if (result.reveal) lines.push('🔍 偷看了一眼命运的底牌（仅自己可见）。');
        if (result.healed) {
            lines.push(`❤️‍🩹 回复 ${result.healed} 点生命。`);
            lines.push(flavor('heal'));
        } else if (result.fullHp) {
            if (result.itemKey === 'cigarette') lines.push('🚬 血量已满，这口烟抽了个寂寞。');
            else if (result.itemKey === 'medicine') lines.push('💊 血量已满，过期药白吃了一粒。');
            else lines.push('❤️ 血量已满，没有回复效果。');
        }
        if (result.lostHp) lines.push(`💔 失去 ${result.lostHp} 点生命。`);
        if (result.ejected) {
            const shellType = result.ejectedLive ? '实弹' : '空弹';
            lines.push(`🍺 弹出当前膛内子弹（${shellType}）。`);
            lines.push(flavor('beer'));
        }
        if (result.flipped) lines.push('🔄 命运翻了个面——膛内子弹已反转。');
        if (result.handcuffedId != null) {
            lines.push(`🔗 **${this.shortName(result.handcuffedId)}** 被铐在了椅子上，下一回合无法行动。`);
            lines.push(flavor('handcuff'));
        }
        if (result.itemKey === 'saw' || result.stolenKey === 'saw') {
            lines.push('🪚 手锯咬住了枪管，下一发实弹翻倍。');
            lines.push(flavor('saw'));
        }
        return lines;
    }

    // ── 惩罚应用（改名复用 parliament 昵称锁） ──

    async applyPenalty(guild, loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        if (penaltyType === 'mute') {
            return this.applyMute(guild, loserId, { minutes });
        }
        return this.applyRename(guild, loserId, { nickname, minutes });
    }

    async applyMute(guild, loserId, { minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '禁言未生效（找不到成员）', false];
        // 权限预检：bot 无法禁言对方（身份组层级更高 / 服务器主人 / bot 自身无 Timeout 权限）。
        // 这是不可重试的失败——不放开按钮让胜者反复点。
        if (member.moderatable === false) {
            return [false, '禁言未生效（我的身份组层级低于对方，无法禁言 TA）', false];
        }
        const mins = minutes || PENALTY_MUTE_MINUTES;
        try {
            await member.timeout(mins * 60_000, PENALTY_MUTE_REASON);
            return [true, `已禁言 ${mins} 分钟`, false];
        } catch (error) {
            logDiscordFailure(this, 'apply-mute', error, loserId);
            const code = error?.code;
            const detail = code === 50013 ? '（我缺少「禁言成员」权限）'
                : code === 50035 ? '（时长参数被 Discord 拒收）' : `（Discord 返回错误 ${code ?? '未知'}）`;
            // 50013 权限缺失不可重试；其他（网络等）可重试。
            return [false, `禁言未生效${detail}`, code !== 50013];
        }
    }

    async applyRename(guild, loserId, { nickname = null, minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '改名未生效（找不到成员）', false];
        const enforced = (nickname || PENALTY_NICKNAME).trim();
        if (!enforced) return [false, '改名未生效（昵称不能为空）', false];
        // 权限预检：bot 无法改对方昵称（层级更高/服务器主人）——不可重试。
        if (member.manageable === false) {
            return [false, '改名未生效（我的身份组层级低于对方，无法改 TA 的昵称）', false];
        }
        const renameMinutes = minutes || PENALTY_RENAME_MINUTES;
        const result = await nicknameLock.service.replaceLock({
            member,
            type: RENAME_LOCK_TYPE,
            enforcedNickname: enforced,
            expiresAt: Date.now() + renameMinutes * 60_000,
            applyReason: PENALTY_RENAME_APPLY_REASON,
            restoreReason: PENALTY_RENAME_RESTORE_REASON,
            enforceReason: PENALTY_RENAME_ENFORCE_REASON,
            channelId: this.channelId,
            expectedTypes: ORDINARY_LOCK_TYPES,
        });
        if (result.created) {
            return [true, `已强制改名 ${renameMinutes} 分钟（新昵称：${enforced}）`, false];
        }
        if (result.reason === 'existing_lock') {
            return [false, '改名未生效（对方正挂着更高优先级的昵称锁）', false];
        }
        // 权限不足或成员状态异常——不可重试。
        return [false, '改名未生效（Bot 权限不足或成员状态）', false];
    }

    async fetchMember(guild, userId) {
        try {
            return await guild?.members?.fetch?.(userId) || null;
        } catch (error) {
            logDiscordFailure(this, 'fetch-member', error, userId);
            return null;
        }
    }

    // ── 视图 ──

    challengeViewRows() {
        // 规则按钮（仅自己可见的详细规则弹窗）放在第一行——应战前就能看。
        const rulesBtn = new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
            .setLabel(ITEM_HELP_LABEL)
            .setStyle(ButtonStyle.Secondary);
        const rows = [new ActionRowBuilder()];
        if (this.targetId == null) {
            // 公屏擂台：任何非发起人的成员都能应战。
            rows[0].addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_accept:${this.id}`)
                    .setLabel('⚔️ 应战')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_cancel:${this.id}`)
                    .setLabel('🛑 发起人取消')
                    .setStyle(ButtonStyle.Secondary),
                rulesBtn
            );
        } else {
            rows[0].addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_accept:${this.id}`)
                    .setLabel('⚔️ 接受挑战')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_decline:${this.id}`)
                    .setLabel('拒绝')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_cancel:${this.id}`)
                    .setLabel('🛑 发起人取消')
                    .setStyle(ButtonStyle.Secondary),
                rulesBtn
            );
        }
        return rows;
    }

    // 第 0 行按钮组：回合指示 + 打对手/打自己（正常面板与软兜底面板共用）。
    turnActionRows0(state) {
        const row0 = new ActionRowBuilder();
        row0.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_turn_hint:${this.id}:${state.turnToken}`)
                .setLabel(`当前回合：@${this.plainName(state.currentPlayerId)}`)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:opponent`)
                .setLabel('🔫 打对手')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:self`)
                .setLabel('💀 打自己')
                .setStyle(ButtonStyle.Danger)
        );
        return row0;
    }

    // 软兜底：人类回合面板必须带开枪按钮。任何按钮构建异常/空结果都退回这套最小可用按钮集，
    // 保证面板永远可操作（不会出现「转手后没有按钮、只能干等 60s 自动开枪」）。
    guaranteedTurnRows(state) {
        const lastRow = new ActionRowBuilder();
        this.addPrivateButton(lastRow);
        this.addItemHelpButton(lastRow);
        return [this.turnActionRows0(state), lastRow];
    }

    // 道具按钮（gameViewRows 第 1 行起，每行最多 5 个；肾上腺素单独走选择菜单）。
    // 同一道具持有多件（如啤酒×2/手机×2）会渲染多个按钮——customId 必须带序号去重，
    // 否则 Discord 报 50035 Invalid Form Body、面板渲染失败。
    // 弹巢只剩一发时的手机/手铐保留"（被禁用）"按钮，点击弹仅我可见解释
    // （customId 尾参 = itemKey:index，双手机也不撞车）；
    // 其余不可用道具（如对手已被铐住时的手铐）按原样不渲染。
    appendItemRows(rows, state, current) {
        const itemKeys = [];
        for (const k of state.items[current]) {
            if (k === 'adrenaline') continue;
            if (state.canUseItem(current, k) || k === 'phone' || k === 'handcuffs') itemKeys.push(k);
        }
        for (let index = 0; index < itemKeys.length; index++) {
            const itemKey = itemKeys[index];
            const button = this.itemButton(state, current, itemKey, index);
            if (button == null) continue;
            const rowIndex = 1 + Math.floor(index / 5);
            if (!rows[rowIndex]) rows[rowIndex] = new ActionRowBuilder();
            rows[rowIndex].addComponents(button);
        }
    }

    // 单个道具按钮：可用 → 正常道具按钮；被禁用（剩一发）→ 解释按钮；对手已铐的手铐 → null。
    itemButton(state, current, itemKey, index) {
        if (!state.canUseItem(current, itemKey)) {
            const blockedByOccupied = itemKey === 'handcuffs'
                && state.handcuffed.has(state.other(current));
            if (blockedByOccupied) return null;
            return new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_phone_blocked:${this.id}:${state.turnToken}:${itemKey}:${index}`)
                .setLabel(`${ITEM_DEFS[itemKey].emoji} ${ITEM_DEFS[itemKey].name}（被禁用）`)
                .setStyle(ButtonStyle.Secondary);
        }
        const item = ITEM_DEFS[itemKey];
        return new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_item:${this.id}:${state.turnToken}:${itemKey}:${index}`)
            .setLabel(`${item.emoji} ${item.name}`)
            .setStyle(STYLE_MAP[ITEM_BUTTON_STYLE[itemKey]] || ButtonStyle.Secondary);
    }

    gameViewRows() {
        const state = this.state;
        if (!state) {
            return [];
        }
        const current = state.currentPlayerId;
        if (current == null) {
            // 待定态：只留 情报 + 游戏规则 两个只读按钮。
            const row = new ActionRowBuilder();
            this.addPrivateButton(row, 0);
            this.addItemHelpButton(row, 0);
            return [row];
        }

        try {
            // 第 0 行：回合指示 + 开枪主行动（与软兜底面板同一构建）。
            const rows = [this.turnActionRows0(state)];

            // 第 1 行起：道具按钮。
            this.appendItemRows(rows, state, current);

            // 肾上腺素：选择菜单（偷取对手哪件道具）。
            if (state.canUseItem(current, 'adrenaline')) {
                const stealable = state._stealableItems(current);
                if (stealable.length) {
                    const selectRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`mystery_devil_roulette_adrenaline:${this.id}:${state.turnToken}`)
                            .setPlaceholder('💉 肾上腺素：偷取对手道具')
                            .addOptions(
                                stealable.map(k => new StringSelectMenuOptionBuilder()
                                    .setLabel(`${ITEM_DEFS[k].emoji} ${ITEM_DEFS[k].name}`)
                                    .setValue(k))
                            )
                    );
                    rows.push(selectRow);
                }
            }

            // 末行：我的情报 + 游戏规则（同一行，情报在左）。
            const lastRow = new ActionRowBuilder();
            this.addPrivateButton(lastRow, 0);
            this.addItemHelpButton(lastRow, 0);
            rows.push(lastRow);
            return rows;
        } catch (error) {
            logDiscordFailure(this, 'game-rows-fallback', error, current);
            return this.guaranteedTurnRows(state);
        }
    }

    addPrivateButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_intel:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(PRIVATE_PANEL_LABEL)
                .setStyle(ButtonStyle.Primary)
        );
    }

    addItemHelpButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(ITEM_HELP_LABEL)
                .setStyle(ButtonStyle.Secondary)
        );
    }

    privateIntelViewRows(userId) {
        // 「📖 游戏规则」面板附带的认输按钮。
        const state = this.state;
        const isPlayer = state != null && userId != null && state.players.includes(userId);
        const lowHp = isPlayer && (state.hp[userId] || 0) <= SURRENDER_MIN_HP;
        let label;
        if (this.status !== 'playing') {
            label = '🏳️ 认输（对局已结束）';
        } else if (!isPlayer) {
            label = '🏳️ 认输（你不在本局中）';
        } else if (lowHp) {
            label = `🏳️ 认输（血量仅剩 ${SURRENDER_MIN_HP} 点，无法使用）`;
        } else {
            label = '🏳️ 认输';
        }
        const canSurrender = this.status === 'playing'
            && state != null
            && userId != null
            && state.players.includes(userId)
            && !lowHp;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_surrender:${this.id}`)
                .setLabel(label)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!canSurrender)
        );
        return [row];
    }

    settlementViewRows() {
        // 败者惩罚由胜者自选（PvP 终局才会 pending）；时长按正常/认输口径。
        if (!this.penaltyPending || this.penaltyApplied) return [];
        const [muteMin, renameMin] = this.penaltyMinutes();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_penalty_mute:${this.id}`)
                .setLabel(`🔇 禁言 ${muteMin} 分钟`)
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_penalty_rename:${this.id}`)
                .setLabel(`✏️ 改名 ${renameMin} 分钟`)
                .setStyle(ButtonStyle.Success)
        );
        return [row];
    }

    // ── 收尾 ──

    disableAllComponents() {
        this.cancelTimerLocked();
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            entry.message.edit({
                components: [],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            }).catch(error => logDiscordFailure(this, 'disable-components', error));
        }
    }

}

// ── 启动入口 ──────────────────────────────────────────────────────────────────

async function startDevilRoulette(interaction, requestedOpponent, {
    onGameStarted,
} = {}) {
    const userId = interaction.user?.id;

    const targetId = requestedOpponent?.id || requestedOpponent?.user?.id || null;
    if (targetId === userId || requestedOpponent?.user?.bot) {
        await interaction.reply({ content: '不能挑战自己或机器人账号。', flags: MessageFlags.Ephemeral });
        return false;
    }

    const session = new DevilRouletteGame({
        mode: 'pvp',
        initiatorId: userId,
        targetId,
        channel: interaction.channel,
        guild: interaction.guild,
    });
    session.onGameStarted = onGameStarted;

    const created = gameManager.createGame(session);
    if (!created.ok) {
        await interaction.reply({
            content: created.reason === 'player'
                ? '你已经在另一场游戏里了。'
                : '这个频道已经有一场游戏在进行中。',
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    // gameManager 把会话克隆成普通对象注册（getGame 走这里）；补回类原型让方法可用。
    Object.setPrototypeOf(created.game, DevilRouletteGame.prototype);
    const game = created.game;
    attachDevilShutdown(game); // 原生收尾：shutdownAllGames 统一驱动
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleDevilRouletteMemberInvalidated(game, invalidUserId);
        }
    };

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'defer-start', error, userId);
        await cleanup(game);
        return false;
    }

    let okOpen = false;
    try {
        okOpen = await game.open();
    } catch (error) {
        okOpen = false;
        logDiscordFailure(game, 'open', error, userId);
    }
    if (!okOpen) {
        await cleanup(game);
        try {
            await interaction.editReply({ content: '我没有权限在这里发送游戏面板。' });
        } catch (error) {
            logDiscordFailure(game, 'open-failure-reply', error, userId);
        }
        return false;
    }
    await interaction.editReply({
        content: targetId == null ? '⚔️ 擂台已摆下，等待勇士应战……' : '恶魔轮盘挑战已发出。',
    });
    return true;
}

// ── 交互分发 ──────────────────────────────────────────────────────────────────

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_devil_roulette_')) {
        tokens[0] = tokens[0].slice('mystery_devil_roulette_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'devil' || tokens[0] === 'roulette') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        turnToken: tokens[2],
        argument: tokens[3],
    };
}

// Discord 昵称禁用字符：@ # : 反斜杠、控制符、空字符。胜者自定的败者昵称必须先清洗，
// 否则 PATCH 被 Discord 拒收 → replaceLock 失败 → 输家逃罚（fail-open）。
function sanitizeRenameNickname(raw) {
    return String(raw ?? '')
        .replace(/[@#:\\\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
}

async function handleRenameModalSubmit(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const gameId = parts[1];
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'devil_roulette') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const raw = interaction.fields?.getTextInputValue?.('devil_roulette_rename_input');
    const nickname = sanitizeRenameNickname(raw);
    if (!nickname) {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, '昵称不能为空，或包含 Discord 禁止的字符（@ # : 等）。');
        return false;
    }
    await game.chooseRenamePenalty(interaction, nickname);
    return true;
}

async function handleDevilRouletteInteraction(interaction, parts) {
    if (interaction.isModalSubmit?.() && typeof interaction.customId === 'string'
        && interaction.customId.startsWith(RENAME_MODAL_PREFIX)) {
        return handleRenameModalSubmit(interaction);
    }
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!game || game.type !== 'devil_roulette') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const { action, turnToken, argument } = parsed;
    switch (action) {
        case 'accept':
            return game.acceptChallenge(interaction);
        case 'decline':
            return game.declineChallenge(interaction);
        case 'cancel':
            return game.cancelByInitiator(interaction);
        case 'turn_hint':
            return game.hintCurrentTurn(interaction);
        case 'refresh':
            return game.refreshPanel(interaction);
        case 'shoot':
            return game.act(interaction, argument === 'self' ? 'shoot_self' : 'shoot_opponent', Number(turnToken));
        case 'item':
            return game.act(interaction, argument, Number(turnToken));
        case 'phone_blocked':
            // 被禁用按钮的道具类型由 handler 按当前持有人道具列表还原（customId 只带序号）。
            return game.showItemBlocked(interaction, argument);
        case 'adrenaline':
            return game.act(interaction, 'adrenaline', Number(turnToken), {
                stealKey: interaction.values?.[0],
            });
        case 'intel':
            return game.showPrivateState(interaction);
        case 'item_help':
            return game.showItemHelp(interaction);
        case 'surrender':
            return game.surrender(interaction);
        case 'penalty_mute':
            return game.chooseMutePenalty(interaction);
        case 'penalty_rename':
            return game.openRenameModal(interaction);
        default:
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return false;
    }
}

// ── 成员失格 ──────────────────────────────────────────────────────────────────

async function handleDevilRouletteMemberInvalidated(game, userId) {
    if (!game || game.type !== 'devil_roulette') return false;
    // 成员仍在公会缓存 → 只是昵称/资料更新，非真正离开，忽略。
    if (game.guild?.members?.cache?.has(userId)) return false;
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.status === 'challenge') {
            game.status = 'ended';
            game.lastEvent = '🧯 有人离开了这间屋子，本局取消。';
            outcome = 'invite_cancel';
            return;
        }
        if (game.status === 'playing' && game.state && game.participants.includes(userId)) {
            game.status = 'ended';
            game.finalWinnerId = game.state.other(userId);
            game.lastEvent = `🏳️ **${game.shortName(userId)}** 从椅子上消失了，本局判负。`;
            outcome = 'forfeit';
        }
    });
    if (!outcome) return false;
    if (outcome === 'forfeit') game.onGameEndedLocked(); // 判负终局同路：惩罚按钮 + 自动施罚
    await game.renderLocked();
    return true;
}

// ── 重启中止 ──────────────────────────────────────────────────────────────────

function cleanup(game) {
    if (!game || game.released) return Promise.resolve();
    game.released = true;
    game.status = 'ended';
    game.cancelTimerLocked();
    game.disableAllComponents();
    game.deletePersisted?.();
    return gameManager.cleanupGame(game);
}

// 恶魔轮盘对局收尾：挂到 game.onShutdown，由 mysteryGameManager.shutdownAllGames 统一驱动
// （原生做法，和加压轮盘同一机制）。删掉本局面板（不留"已失效"死按钮），快照保留供下次启动续接；
// 全局冲刷快照写队列（幂等操作，多局并行收尾时重复调用无害）。
function attachDevilShutdown(game) {
    game.onShutdown = async () => {
        game.cancelTimerLocked?.();
        for (const entry of [...(game.panels || [])]) {
            const msg = entry?.message;
            if (!msg || typeof msg.delete !== 'function') continue;
            await msg.delete().catch(error => logDiscordFailure(game, 'shutdown-delete-panel', error));
        }
        game.panels = [];
        game.itemPanelEntry = null;
        try {
            await resumeStore.flush();
        } catch (error) {
            logDiscordFailure(null, 'resume-flush', error);
        }
    };
    return game;
}

// 启动时把上次没打完的恶魔轮盘对局接回来（断连接续）。
async function restoreActiveGames(client) {
    let snapshots = [];
    try {
        snapshots = await resumeStore.list();
    } catch (error) {
        logDiscordFailure(null, 'resume-list', error);
        return 0;
    }
    let restored = 0;
    for (const snap of snapshots) {
        try {
            if (!snap || snap.v !== 1 || !snap.id || !snap.guildId || !snap.channelId) continue;
            if (snap.mode !== 'pvp') { // 仅支持 PvP 快照；其余（异常/损坏数据）直接清掉。
                resumeStore.remove(snap.id);
                continue;
            }
            if (gameManager.getGame(snap.id)) continue; // 已恢复
            const guild = client.guilds?.cache?.get(snap.guildId)
                || await client.guilds.fetch(snap.guildId).catch(() => null);
            if (!guild) {
                // 机器人已不在该服，快照失去意义，清掉。
                resumeStore.remove(snap.id);
                continue;
            }
            const channel = guild.channels?.cache?.get(snap.channelId)
                || await guild.channels.fetch(snap.channelId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') {
                resumeStore.remove(snap.id);
                continue;
            }
            const game = DevilRouletteGame.restore(snap, { guild, channel });
            // 与正常开局一致：把完整实例交给 gameManager（它克隆成普通对象），再补回类原型，
            // 否则 getGame 拿到的是无方法/无 state 的裸对象，点击一律"已失效"。
            const reg = gameManager.createGame(game);
            if (!reg.ok) continue; // 锁冲突（启动时理论上不会），快照留着下次再试
            Object.setPrototypeOf(reg.game, DevilRouletteGame.prototype);
            const restoredGame = reg.game;
            restoredGame.onMemberInvalidated = async invalidMember => {
                const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
                if (invalidUserId) await handleDevilRouletteMemberInvalidated(restoredGame, invalidUserId);
            };
            attachDevilShutdown(restoredGame); // 原生收尾：恢复的对局同样挂 onShutdown
            // 预取对局成员进 guild 缓存：重启后 members.cache 是空的，不补的话
            // 面板上的玩家名会退化成「玩家<id>」（plainName 只读缓存）。
            for (const pid of restoredGame.participants) {
                if (!pid) continue;
                await guild.members.fetch(pid).catch(() => {});
            }
            // 清掉上次进程残留的旧面板（优雅退出已由 onShutdown 删掉，这里兜底非优雅退出的漏网），
            // 避免频道里留下点了就"已失效"的死面板；随后 renderLocked 发新面板续接。
            for (const msgId of Array.isArray(snap.panelIds) ? snap.panelIds : []) {
                if (!msgId) continue;
                await channel.messages.delete(msgId).catch(() => {});
            }
            await restoredGame.renderLocked();
            restored += 1;
        } catch (error) {
            logDiscordFailure(null, 'resume-restore', error, snap?.id);
        }
    }
    if (restored > 0) {
        console.log(`[DevilRoulette] 断连接续：恢复 ${restored} 场未完成的对局。`);
    }
    return restored;
}

module.exports = {
    startDevilRoulette,
    handleDevilRouletteInteraction,
    restoreActiveGames,
    // 供 interactionHandler 路由 rename modal 提交。
    RENAME_MODAL_PREFIX,
};
