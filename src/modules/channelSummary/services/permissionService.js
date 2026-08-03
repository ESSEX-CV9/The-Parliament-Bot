// src/modules/channelSummary/services/permissionService.js

const presetService = require("./presetService");
const {
  checkAdminPermission,
} = require("../../../core/utils/permissionManager");

const PERM_DENIED = "❌ 权限不足：仅授权用户使用此功能。";

/**
 * 使用全局统一规则判断用户是否拥有管理员权限
 */
function isAdmin(member) {
  return checkAdminPermission(member);
}

/**
 * 判断用户是否拥有全局授权身份组（查 summary_authorized_roles 表）
 */
function isAuthorized(member) {
  const memberRoleIds = [...member.roles.cache.keys()];
  return presetService.hasAnyAuthorizedRole(memberRoleIds);
}

/**
 * 获取用户权限等级
 * @returns {"admin" | "authorized" | "normal"}
 */
function getPermissionLevel(member, guildId) {
  if (isAdmin(member)) return "admin";
  if (isAuthorized(member)) return "authorized";
  return "normal";
}

module.exports = {
  PERM_DENIED,
  isAdmin,
  isAuthorized,
  getPermissionLevel,
};
