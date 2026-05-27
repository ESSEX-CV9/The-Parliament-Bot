const fs = require('fs');

async function cleanupDir(dirPath) {
  await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

async function cleanupFile(filePath) {
  await fs.promises.unlink(filePath).catch(() => {});
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

module.exports = { cleanupDir, cleanupFile, ensureDir };
