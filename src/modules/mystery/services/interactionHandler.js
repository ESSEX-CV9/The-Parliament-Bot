const { MessageFlags } = require('discord.js');
const gameManager = require('./mysteryGameManager');
const { handleRouletteInteraction } = require('./rouletteGame');
const { handleBombInteraction } = require('./bombGame');
const { handleDuelInteraction } = require('./duelGame');

const MYSTERY_CUSTOM_ID_PREFIX = 'mystery_';
const EXPIRED_INTERACTION_MESSAGE = '⌛ **这次游戏交互已经过期或失效了。**';
const FAILED_INTERACTION_MESSAGE = '❌ **处理这次游戏操作时出了点问题，请稍后再试。**';
const SIMPLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const ROUTES = Object.freeze({
    roulette: {
        join: { component: 'button', partCount: 2 },
    },
    bomb: {
        join: { component: 'button', partCount: 2 },
        pass: { component: 'button', partCount: 3, tokenIndex: 2 },
        target: { component: 'string', partCount: 3, tokenIndex: 2 },
    },
    duel: {
        accept: { component: 'button', partCount: 2 },
        choice: { component: 'button', partCount: 4 },
    },
});

const DOWNSTREAM_HANDLERS = Object.freeze({
    roulette: handleRouletteInteraction,
    bomb: handleBombInteraction,
    duel: handleDuelInteraction,
});

function componentKind(interaction) {
    if (interaction?.isButton?.()) return 'button';
    if (interaction?.isStringSelectMenu?.()) return 'string';
    return null;
}

function parseMysteryCustomId(customId, kind) {
    if (typeof customId !== 'string' || !customId.startsWith(MYSTERY_CUSTOM_ID_PREFIX)) {
        return null;
    }

    const parts = customId.split(':');
    const routeMatch = /^mystery_(roulette|bomb|duel)_([a-z]+)$/.exec(parts[0]);
    if (!routeMatch) return { valid: false, parts };

    const [, type, action] = routeMatch;
    const route = ROUTES[type]?.[action];
    const gameId = parts[1];
    if (
        !route
        || route.component !== kind
        || parts.length !== route.partCount
        || !SIMPLE_ID_PATTERN.test(gameId || '')
    ) {
        return { valid: false, type, action, gameId, parts };
    }

    if (route.tokenIndex !== undefined && !/^\d+$/.test(parts[route.tokenIndex])) {
        return { valid: false, type, action, gameId, parts };
    }
    if (type === 'duel' && action === 'choice') {
        if (!SIMPLE_ID_PATTERN.test(parts[2] || '') || !['rock', 'scissors', 'paper'].includes(parts[3])) {
            return { valid: false, type, action, gameId, parts };
        }
    }

    return { valid: true, type, action, gameId, parts };
}

function logHandlerError(parsed, interaction, phase, error) {
    const context = [
        `type=${parsed?.type || 'unknown'}`,
        `action=${parsed?.action || 'unknown'}`,
        `game=${parsed?.gameId || 'unknown'}`,
        `user=${interaction?.user?.id || 'unknown'}`,
        `phase=${phase}`,
    ].join(' ');
    console.error(`[MysteryInteraction] ${context}`, error);
}

async function safePrivateResponse(interaction, content, parsed, phase) {
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply({ content });
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else if (!interaction.deferred && !interaction.replied && typeof interaction.reply === 'function') {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        } else {
            return false;
        }
        return true;
    } catch (error) {
        logHandlerError(parsed, interaction, phase, error);
        return false;
    }
}

async function handleMysteryInteraction(interaction) {
    const kind = componentKind(interaction);
    if (!kind || typeof interaction?.customId !== 'string') return false;
    if (!interaction.customId.startsWith(MYSTERY_CUSTOM_ID_PREFIX)) return false;

    let parsed;
    try {
        parsed = parseMysteryCustomId(interaction.customId, kind);
        const game = parsed?.valid && gameManager.getGame(parsed.gameId);
        if (!parsed?.valid || !game || game.type !== parsed.type) {
            await safePrivateResponse(
                interaction,
                EXPIRED_INTERACTION_MESSAGE,
                parsed,
                'expired-response'
            );
            return true;
        }

        await DOWNSTREAM_HANDLERS[parsed.type](interaction, parsed.parts);
        return true;
    } catch (error) {
        logHandlerError(parsed, interaction, 'route', error);
        await safePrivateResponse(
            interaction,
            FAILED_INTERACTION_MESSAGE,
            parsed,
            'failure-response'
        );
        return false;
    }
}

module.exports = {
    MYSTERY_CUSTOM_ID_PREFIX,
    handleMysteryInteraction,
};
