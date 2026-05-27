const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { ensureDir } = require('../utils/cleanup');

async function createDiskArchive(backupId) {
  await ensureDir(config.tempDir);

  const tempFilePath = path.join(config.tempDir, `backup_${backupId}_${Date.now()}.zip`);
  const output = fs.createWriteStream(tempFilePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.pipe(output);

  const finalize = () =>
    new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.finalize();
    });

  return { archive, tempFilePath, finalize };
}

module.exports = { createDiskArchive };
