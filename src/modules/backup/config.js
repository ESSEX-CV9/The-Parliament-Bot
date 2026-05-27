module.exports = {
  messageFetchDelay: 200,
  attachmentTimeout: 30000,
  maxAttachmentSize: 25 * 1024 * 1024,
  progressUpdateInterval: 3000,
  uploadRetries: 2,
  uploadRetryDelay: 5000,
  uploadToken: process.env.UPLOAD_TOKEN || '',
  tempDir: process.env.BACKUP_TEMP_DIR || './temp',
};
