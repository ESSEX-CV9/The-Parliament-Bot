const express = require('express');
const { authMiddleware, csrfMiddleware, loginRoute, callbackRoute, logoutRoute } = require('./auth');
const createRoutes = require('./routes');

let httpServer = null;

function createDashboardApp(client) {
    const app = express();

    app.disable('x-powered-by');

    // Trust reverse proxy (Nginx/Cloudflare) for correct client IP
    if (process.env.DASHBOARD_TRUST_PROXY) {
        app.set('trust proxy', parseInt(process.env.DASHBOARD_TRUST_PROXY) || 1);
    }

    // Security headers
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('X-XSS-Protection', '0');  // modern browsers use CSP instead
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "img-src 'self' https://cdn.discordapp.com",
            "font-src 'self' https://cdn.jsdelivr.net",
            "connect-src 'self'",
            "frame-ancestors 'none'",
        ].join('; '));
        if (process.env.DASHBOARD_SECURE_COOKIE !== 'false') {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        next();
    });

    // Rate limiting
    const rateLimitMap = new Map();
    const RATE_WINDOW_MS = 60_000;
    const RATE_MAX_GENERAL = parseInt(process.env.DASHBOARD_RATE_LIMIT) || 100;
    const RATE_MAX_AUTH = 5;

    function rateLimit(max) {
        return (req, res, next) => {
            const ip = req.ip || req.socket.remoteAddress;
            const key = `${ip}:${max}`;
            const now = Date.now();
            const entry = rateLimitMap.get(key);
            if (!entry || now - entry.start > RATE_WINDOW_MS) {
                rateLimitMap.set(key, { start: now, count: 1 });
                return next();
            }
            entry.count++;
            if (entry.count > max) {
                res.setHeader('Retry-After', Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000));
                return res.status(429).send('Too Many Requests');
            }
            next();
        };
    }

    // Cleanup rate limit entries periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of rateLimitMap) {
            if (now - entry.start > RATE_WINDOW_MS) rateLimitMap.delete(key);
        }
    }, RATE_WINDOW_MS);

    // Apply stricter rate limit to auth routes
    app.use('/login', rateLimit(RATE_MAX_AUTH));
    app.use('/callback', rateLimit(RATE_MAX_AUTH));

    // General rate limit
    app.use(rateLimit(RATE_MAX_GENERAL));

    // Body parsers for POST form submissions
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '16kb' }));

    // Public routes (no auth required)
    app.get('/login', loginRoute);
    app.get('/callback', callbackRoute(client));
    app.get('/logout', logoutRoute);

    // Protected routes
    app.use(authMiddleware);
    app.use(csrfMiddleware);
    app.use('/', createRoutes(client));

    // Error handler
    app.use((err, _req, res, _next) => {
        console.error('[RoleSync Dashboard] Error:', err);
        res.status(500).send('Internal Server Error');
    });

    return app;
}

function startDashboard(client) {
    const port = parseInt(process.env.ROLE_SYNC_DASHBOARD_PORT) || 3847;
    const clientId = process.env.DISCORD_OAUTH_CLIENT_ID || process.env.CLIENT_ID;
    const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log('[RoleSync Dashboard] OAuth2 credentials not configured, skipping dashboard.');
        return;
    }

    const app = createDashboardApp(client);
    httpServer = app.listen(port, () => {
        console.log(`[RoleSync Dashboard] Running on http://localhost:${port}`);
    });
}

function stopDashboard() {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
        console.log('[RoleSync Dashboard] Stopped.');
    }
}

module.exports = { startDashboard, stopDashboard };
