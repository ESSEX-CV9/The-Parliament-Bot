const path = require('path');
const { Readable } = require('stream');
const config = require('../config');

async function streamAttachmentToArchive(attachment, archive, channelPrefix) {
  if (attachment.size > config.maxAttachmentSize) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.attachmentTimeout);

  try {
    const response = await fetch(attachment.url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return false;

    const ext = path.extname(attachment.filename) || '';
    const filename = `${attachment.id}${ext}`;
    const entryName = channelPrefix
      ? `${channelPrefix}/attachments/${filename}`
      : `attachments/${filename}`;

    const readable = Readable.fromWeb(response.body);
    archive.append(readable, { name: entryName });

    await new Promise((resolve, reject) => {
      readable.on('end', resolve);
      readable.on('error', reject);
    });

    return true;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return false;
    throw err;
  }
}

module.exports = { streamAttachmentToArchive };
