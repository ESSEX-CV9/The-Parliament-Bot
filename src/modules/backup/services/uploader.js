const fs = require('fs');
const config = require('../config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadFile(filePath, destinationUrl) {
  let lastError;

  for (let attempt = 0; attempt <= config.uploadRetries; attempt++) {
    try {
      const fileStream = fs.createReadStream(filePath);

      const headers = {
        'Content-Type': 'application/zip',
      };
      if (config.uploadToken) {
        headers['Authorization'] = `Bearer ${config.uploadToken}`;
      }

      const response = await fetch(destinationUrl, {
        method: 'POST',
        headers,
        body: fileStream,
        duplex: 'half',
      });

      if (response.ok) return;

      const status = response.status;
      lastError = new Error(`上传失败：服务器返回 ${status}`);

      if (status >= 400 && status < 500) throw lastError;

      if (attempt < config.uploadRetries) {
        await sleep(config.uploadRetryDelay * (attempt + 1));
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err;
      if (attempt < config.uploadRetries) {
        await sleep(config.uploadRetryDelay * (attempt + 1));
      }
    }
  }

  throw lastError;
}

module.exports = { uploadFile };
