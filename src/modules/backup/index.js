const backup = require('./commands/backup');
const channels = require('./commands/channels');

module.exports = {
  commands: [backup, channels],
};
