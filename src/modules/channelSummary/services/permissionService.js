// src/modules/channelSummary/services/permissionService.js

const presetService = require("./presetService");

const PERM_DENIED = "❌ 权限不足：仅授权用户使用此功能。";

function parseEnvList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判断用户是否拥有管理员身份组（from .env SUMMARY_ADMIN_ROLE_IDS）
 */
function isAdmin(member) {
  const adminRoleIds = parseEnvList(process.env.SUMMARY_ADMIN_ROLE_IDS);
  if (adminRoleIds.length === 0) return false;
  return adminRoleIds.some((rid) => member.roles.cache.has(rid));
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
  parseEnvList,
  isAdmin,
  isAuthorized,
  getPermissionLevel,
};
