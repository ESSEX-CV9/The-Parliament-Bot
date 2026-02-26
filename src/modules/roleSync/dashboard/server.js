const express = require('express');
const { authMiddleware, csrfMiddleware, loginRoute, callbackRoute, logoutRoute } = require('./auth');
const createRoutes = require('./routes');

let httpServer = null;

function createDashboardApp(client) {
    const app = express();

    app.disable('x-powered-by');

    // Body parsers for POST form submissions
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());

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
