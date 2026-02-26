const { Router } = require('express');

module.exports = function createRoutes(client) {
    const router = Router();

    router.use('/', require('./overview'));
    router.use('/', require('./members')(client));
    router.use('/', require('./jobs'));
    router.use('/', require('./logs'));
    router.use('/', require('./config'));

    return router;
};
