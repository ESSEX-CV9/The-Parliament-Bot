const crypto = require('crypto');
const { checkAdminByRoleIds, ALLOWED_ROLE_IDS } = require('../../../core/utils/permissionManager');

const DISCORD_API = 'https://discord.com/api/v10';

// In-memory session store: token -> { userId, username, avatar, csrfToken, expiresAt }
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup expired sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (session.expiresAt < now) {
            sessions.delete(token);
        }
    }
}, 60 * 60 * 1000);

function getOAuthConfig() {
    const clientId = process.env.DISCORD_OAUTH_CLIENT_ID || process.env.CLIENT_ID;
    const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI || 'http://localhost:3847/callback';
    return { clientId, clientSecret, redirectUri };
}

function getSessionFromCookie(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const match = cookieHeader.split(';').find(c => c.trim().startsWith('rs_session='));
    if (!match) return null;

    const token = match.split('=')[1].trim();
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
        sessions.delete(token);
        return null;
    }
    return session;
}

// GET /login
function loginRoute(_req, res) {
    const { clientId, redirectUri } = getOAuthConfig();
    const state = crypto.randomBytes(16).toString('hex');
    const scope = 'identify guilds.members.read';
    const url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    res.redirect(url);
}

// GET /callback - returns a handler that captures `client`
function callbackRoute(client) {
    return async (req, res) => {
        const code = req.query.code;
        if (!code) {
            return res.status(400).send('Missing authorization code');
        }

        const { clientId, clientSecret, redirectUri } = getOAuthConfig();

        try {
            // Exchange code for access token
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                }),
            });

            if (!tokenRes.ok) {
                console.error('[RoleSync Dashboard] OAuth token exchange failed:', await tokenRes.text());
                return res.status(500).send('OAuth token exchange failed');
            }

            const tokenData = await tokenRes.json();
            const accessToken = tokenData.access_token;

            // Fetch user info
            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (!userRes.ok) {
                return res.status(500).send('Failed to fetch user info');
            }

            const user = await userRes.json();

            // Check admin permission by iterating bot guilds and fetching member roles via OAuth
            const hasPermission = await checkUserPermissionViaOAuth(accessToken, client, user.id);

            // Revoke the access token immediately - we only needed it for auth check
            revokeToken(accessToken, clientId, clientSecret).catch(() => {});

            if (!hasPermission) {
                return res.status(403).send(renderAccessDenied(user.username));
            }

            // Create session
            const sessionToken = crypto.randomBytes(32).toString('hex');
            sessions.set(sessionToken, {
                userId: user.id,
                username: user.username,
                avatar: user.avatar,
                csrfToken: crypto.randomBytes(24).toString('hex'),
                expiresAt: Date.now() + SESSION_TTL_MS,
            });

            const secure = process.env.DASHBOARD_SECURE_COOKIE !== 'false' ? '; Secure' : '';
            res.setHeader('Set-Cookie', `rs_session=${sessionToken}; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
            res.redirect('/');

        } catch (error) {
            console.error('[RoleSync Dashboard] OAuth callback error:', error);
            res.status(500).send('Authentication failed');
        }
    };
}

async function checkUserPermissionViaOAuth(accessToken, client, userId) {
    // Iterate all guilds the bot is in, try to fetch user's member info via OAuth endpoint
    for (const guild of client.guilds.cache.values()) {
        try {
            // Check if user is guild owner
            if (guild.ownerId === userId) {
                return true;
            }

            const memberRes = await fetch(`${DISCORD_API}/users/@me/guilds/${guild.id}/member`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (!memberRes.ok) continue; // User not in this guild or no access

            const memberData = await memberRes.json();
            const roleIds = memberData.roles || [];

            if (checkAdminByRoleIds(roleIds)) {
                return true;
            }
        } catch {
            continue;
        }
    }
    return false;
}

async function revokeToken(token, clientId, clientSecret) {
    await fetch(`${DISCORD_API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token,
        }),
    });
}

function renderAccessDenied(username) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Access Denied</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
</head><body><main class="container" style="text-align:center;margin-top:5rem;">
<h1>Access Denied</h1>
<p>${username}, you do not have admin permissions in any of the bot's guilds.</p>
<p>Required: one of the configured admin role IDs, server owner, or Administrator permission.</p>
<a href="/login">Try again</a>
</main></body></html>`;
}

// GET /logout
function logoutRoute(req, res) {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        const match = cookieHeader.split(';').find(c => c.trim().startsWith('rs_session='));
        if (match) {
            const token = match.split('=')[1].trim();
            sessions.delete(token);
        }
    }
    const secure = process.env.DASHBOARD_SECURE_COOKIE !== 'false' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rs_session=; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=0`);
    res.redirect('/login');
}

// Auth middleware
function authMiddleware(req, res, next) {
    const session = getSessionFromCookie(req);
    if (!session) {
        return res.redirect('/login');
    }
    req.session = { user: session };
    next();
}

// CSRF middleware for POST/PUT/DELETE requests
function csrfMiddleware(req, res, next) {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        const sessionCsrf = req.session?.user?.csrfToken;
        const formCsrf = req.body?._csrf || req.headers?.['x-csrf-token'];
        if (!sessionCsrf || sessionCsrf !== formCsrf) {
            return res.status(403).send('CSRF token mismatch');
        }
    }
    next();
}

module.exports = { authMiddleware, csrfMiddleware, loginRoute, callbackRoute, logoutRoute, getSessionFromCookie };
