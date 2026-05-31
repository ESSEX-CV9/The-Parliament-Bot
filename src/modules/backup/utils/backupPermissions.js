const ALLOWED_BACKUP_USER_IDS = [
  '757946225323671664',
  '1231975942725963816',
  '604618688880050176',
  '724158063984115713',
];

function checkBackupPermission(userId) {
  return ALLOWED_BACKUP_USER_IDS.includes(String(userId || ''));
}

function getBackupPermissionDeniedMessage() {
  return '❌ 你没有权限使用备份系列指令。';
}

module.exports = {
  ALLOWED_BACKUP_USER_IDS,
  checkBackupPermission,
  getBackupPermissionDeniedMessage,
};
