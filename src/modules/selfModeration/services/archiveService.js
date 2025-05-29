// src\modules\selfModeration\services\archiveService.js
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getArchiveChannelSettings } = require('../../../core/utils/database');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// 附件存储配置
const ATTACHMENTS_DIR = path.join(__dirname, '../../../../data/attachments');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB 限制
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi', '.pdf', '.txt', '.doc', '.docx', '.zip', '.rar'];

// 🔥 新增：媒体文件扩展名（需要添加剧透效果的文件类型）
const MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv', '.wmv'];

// 🔥 新增：清理配置
const CLEANUP_INTERVAL_HOURS = 1; // 每小时清理一次
const CLEANUP_FILE_AGE_HOURS = 24; // 删除24小时前的文件
let cleanupTimer = null;

/**
 * 确保附件目录存在
 */
async function ensureAttachmentsDir() {
    try {
        await fs.access(ATTACHMENTS_DIR);
    } catch {
        await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
    }
}

/**
 * 下载附件到本地
 * @param {string} url - 附件URL
 * @param {string} filename - 原始文件名
 * @param {string} messageId - 消息ID
 * @returns {Promise<{success: boolean, localPath?: string, error?: string}>}
 */
async function downloadAttachment(url, filename, messageId) {
    try {
        await ensureAttachmentsDir();
        
        // 生成唯一文件名：消息ID_时间戳_原文件名
        const timestamp = Date.now();
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);
        const uniqueFilename = `${messageId}_${timestamp}_${baseName}${ext}`;
        const localPath = path.join(ATTACHMENTS_DIR, uniqueFilename);
        
        // 检查文件扩展名
        if (!ALLOWED_EXTENSIONS.includes(ext.toLowerCase())) {
            return {
                success: false,
                error: `不支持的文件类型: ${ext}`
            };
        }
        
        return new Promise((resolve) => {
            const client = url.startsWith('https:') ? https : http;
            
            const request = client.get(url, (response) => {
                // 检查响应状态
                if (response.statusCode !== 200) {
                    resolve({
                        success: false,
                        error: `下载失败，状态码: ${response.statusCode}`
                    });
                    return;
                }
                
                // 检查文件大小
                const contentLength = parseInt(response.headers['content-length'] || '0');
                if (contentLength > MAX_FILE_SIZE) {
                    resolve({
                        success: false,
                        error: `文件过大: ${formatFileSize(contentLength)} (最大 ${formatFileSize(MAX_FILE_SIZE)})`
                    });
                    return;
                }
                
                // 创建写入流
                const fileStream = require('fs').createWriteStream(localPath);
                let downloadedBytes = 0;
                
                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes > MAX_FILE_SIZE) {
                        fileStream.destroy();
                        fs.unlink(localPath).catch(() => {}); // 删除部分下载的文件
                        resolve({
                            success: false,
                            error: `文件过大: ${formatFileSize(downloadedBytes)} (最大 ${formatFileSize(MAX_FILE_SIZE)})`
                        });
                        return;
                    }
                });
                
                response.pipe(fileStream);
                
                fileStream.on('finish', () => {
                    resolve({
                        success: true,
                        localPath: uniqueFilename // 返回相对路径
                    });
                });
                
                fileStream.on('error', (error) => {
                    resolve({
                        success: false,
                        error: `写入文件失败: ${error.message}`
                    });
                });
            });
            
            request.on('error', (error) => {
                resolve({
                    success: false,
                    error: `下载请求失败: ${error.message}`
                });
            });
            
            // 设置超时
            request.setTimeout(30000, () => {
                request.destroy();
                resolve({
                    success: false,
                    error: '下载超时'
                });
            });
        });
        
    } catch (error) {
        return {
            success: false,
            error: `下载附件时出错: ${error.message}`
        };
    }
}

/**
 * 🔥 新增：检查文件是否为媒体文件
 * @param {string} filename - 文件名
 * @returns {boolean} 是否为媒体文件
 */
function isMediaFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
}

/**
 * 🔥 新增：为媒体文件生成带剧透效果的文件名
 * @param {string} filename - 原始文件名
 * @returns {string} 处理后的文件名
 */
function getSpoilerFilename(filename) {
    if (isMediaFile(filename)) {
        return `SPOILER_${filename}`;
    }
    return filename;
}

/**
 * 归档被删除的消息
 * @param {Client} client - Discord客户端
 * @param {object} messageInfo - 消息信息
 * @param {object} voteData - 投票数据
 * @returns {boolean} 是否成功归档
 */
async function archiveDeletedMessage(client, messageInfo, voteData) {
    try {
        const { guildId, currentReactionCount, targetMessageUrl, initiatorId, type } = voteData;
        
        // 获取归档频道设置
        const archiveSettings = await getArchiveChannelSettings(guildId);
        if (!archiveSettings || !archiveSettings.enabled || !archiveSettings.channelId) {
            console.log(`服务器 ${guildId} 未设置归档频道，跳过归档`);
            return false;
        }
        
        // 获取归档频道
        const archiveChannel = await client.channels.fetch(archiveSettings.channelId);
        if (!archiveChannel) {
            console.error(`归档频道 ${archiveSettings.channelId} 不存在`);
            return false;
        }
        
        // 🔥 根据投票类型调整标题和描述
        const actionType = type === 'delete' ? '删除消息投票' : '禁言用户投票';
        const actionIcon = type === 'delete' ? '🗑️' : '🔇';
        const reasonText = type === 'delete' 
            ? '因达到⚠️反应阈值被自助管理系统删除' 
            : '因禁言用户投票达到阈值被删除';
        
        // 构建归档嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(`📁 消息归档记录 ${actionIcon}`)
            .setDescription(`以下消息${reasonText}`)
            .addFields(
                {
                    name: '📝 原消息内容',
                    value: messageInfo.content || '*（无文字内容或内容为空）*',
                    inline: false
                },
                {
                    name: '👤 消息作者',
                    value: `<@${messageInfo.authorId}> (${messageInfo.author})`,
                    inline: true
                },
                {
                    name: '📍 原消息位置',
                    value: `[跳转到原位置](${targetMessageUrl})`,
                    inline: true
                },
                {
                    name: '⚠️ 反应数量',
                    value: `${currentReactionCount}个（去重后）`,
                    inline: true
                },
                {
                    name: '🚀 发起人',
                    value: `<@${initiatorId}>`,
                    inline: true
                },
                {
                    name: '🕐 删除时间',
                    value: `<t:${Math.floor(Date.now() / 1000)}:f>`,
                    inline: true
                },
                {
                    name: '📋 投票类型',
                    value: actionType,
                    inline: true
                },
                {
                    name: '🔗 消息ID',
                    value: `\`${messageInfo.messageId || '未知'}\``,
                    inline: false
                }
            )
            .setColor(type === 'delete' ? '#FF6B6B' : '#FF8C00') // 🔥 不同类型不同颜色
            .setTimestamp();
        
        // 处理附件下载和归档
        const attachmentFiles = [];
        let hasMediaFiles = false; // 🔥 新增：标记是否包含媒体文件
        
        if (messageInfo.attachments && messageInfo.attachments.length > 0) {
            const attachmentResults = [];
            
            for (const att of messageInfo.attachments) {
                console.log(`开始下载附件: ${att.name} (${formatFileSize(att.size)})`);
                
                const downloadResult = await downloadAttachment(att.url, att.name, messageInfo.messageId);
                
                if (downloadResult.success) {
                    // 🔥 检查是否为媒体文件
                    const isMedia = isMediaFile(att.name);
                    if (isMedia) {
                        hasMediaFiles = true;
                    }
                    
                    // 🔥 为媒体文件添加剧透标记
                    const displayName = isMedia ? `🔞 ${att.name} (媒体文件，已添加剧透效果)` : att.name;
                    attachmentResults.push(`✅ [${displayName}](attachment://${downloadResult.localPath}) (${formatFileSize(att.size)}) - 已保存`);
                    
                    // 🔥 添加到要发送的文件列表，媒体文件使用剧透文件名
                    const fullPath = path.join(ATTACHMENTS_DIR, downloadResult.localPath);
                    const spoilerFilename = getSpoilerFilename(downloadResult.localPath);
                    attachmentFiles.push(new AttachmentBuilder(fullPath, { name: spoilerFilename }));
                    
                    console.log(`✅ 成功下载附件: ${att.name} -> ${downloadResult.localPath}${isMedia ? ' (将添加剧透效果)' : ''}`);
                } else {
                    attachmentResults.push(`❌ [${att.name}](${att.url}) (${formatFileSize(att.size)}) - 下载失败: ${downloadResult.error}`);
                    console.error(`❌ 下载附件失败: ${att.name} - ${downloadResult.error}`);
                }
            }
            
            // 🔥 修改附件字段，添加媒体文件说明
            let attachmentFieldValue = attachmentResults.join('\n');
            if (hasMediaFiles) {
                attachmentFieldValue += '\n\n⚠️ **注意**: 媒体文件（图片、视频等）已自动添加剧透效果，点击查看时请注意内容适宜性。';
            }
            
            // 检查字段值长度，如果超过1024字符则截断
            const MAX_FIELD_LENGTH = 1024;
            if (attachmentFieldValue.length > MAX_FIELD_LENGTH) {
                const truncated = attachmentFieldValue.substring(0, MAX_FIELD_LENGTH - 50);
                attachmentFieldValue = truncated + '\n\n... (内容过长已截断)';
            }
            
            // 如果附件太多，只显示摘要
            if (attachmentResults.length > 5) {
                const successCount = attachmentResults.filter(r => r.startsWith('✅')).length;
                const failCount = attachmentResults.filter(r => r.startsWith('❌')).length;
                
                embed.addFields({
                    name: '📎 附件摘要',
                    value: `总计 ${attachmentResults.length} 个附件\n✅ 成功保存: ${successCount}\n❌ 下载失败: ${failCount}`,
                    inline: false
                });
                
                // 如果有失败的附件，单独显示失败列表
                if (failCount > 0) {
                    const failedAttachments = attachmentResults
                        .filter(r => r.startsWith('❌'))
                        .slice(0, 3) // 最多显示3个失败的
                        .join('\n');
                    
                    embed.addFields({
                        name: '❌ 下载失败的附件',
                        value: failedAttachments + (failCount > 3 ? '\n...' : ''),
                        inline: false
                    });
                }
            } else {
                // 附件不多时，正常显示
                embed.addFields({
                    name: '📎 附件',
                    value: attachmentFieldValue,
                    inline: false
                });
            }
        }
        
        // 如果消息有嵌入内容，记录嵌入数量
        if (messageInfo.embeds && messageInfo.embeds.length > 0) {
            embed.addFields({
                name: '🎴 嵌入消息',
                value: `包含 ${messageInfo.embeds.length} 个嵌入消息`,
                inline: false
            });
        }
        
        // 🔥 如果包含媒体文件，在嵌入消息中添加额外警告
        if (hasMediaFiles) {
            embed.addFields({
                name: '🔞 内容警告',
                value: '此消息包含媒体文件，已自动添加剧透效果。查看前请确认内容适宜性。',
                inline: false
            });
        }
        
        // 发送归档消息（包含附件）
        const messageOptions = { embeds: [embed] };
        if (attachmentFiles.length > 0) {
            messageOptions.files = attachmentFiles;
        }
        
        await archiveChannel.send(messageOptions);
        
        console.log(`成功归档消息到频道 ${archiveChannel.name} (${archiveChannel.id})，类型: ${actionType}，附件数量: ${attachmentFiles.length}${hasMediaFiles ? '（包含媒体文件，已添加剧透效果）' : ''}`);
        return true;
        
    } catch (error) {
        console.error('归档消息时出错:', error);
        return false;
    }
}

/**
 * 格式化文件大小显示
 * @param {number} bytes - 文件大小（字节）
 * @returns {string} 格式化的文件大小
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 检查归档频道是否可用
 * @param {Client} client - Discord客户端
 * @param {string} guildId - 服务器ID
 * @returns {object} {available: boolean, channel: Channel|null, error: string|null}
 */
async function checkArchiveChannelAvailable(client, guildId) {
    try {
        const archiveSettings = await getArchiveChannelSettings(guildId);
        if (!archiveSettings || !archiveSettings.enabled || !archiveSettings.channelId) {
            return {
                available: false,
                channel: null,
                error: '未设置归档频道'
            };
        }
        
        const archiveChannel = await client.channels.fetch(archiveSettings.channelId);
        if (!archiveChannel) {
            return {
                available: false,
                channel: null,
                error: '归档频道不存在'
            };
        }
        
        // 检查机器人权限
        const botMember = archiveChannel.guild.members.me;
        const permissions = archiveChannel.permissionsFor(botMember);
        
        if (!permissions.has('SendMessages')) {
            return {
                available: false,
                channel: archiveChannel,
                error: '机器人无权在归档频道发送消息'
            };
        }
        
        if (!permissions.has('EmbedLinks')) {
            return {
                available: false,
                channel: archiveChannel,
                error: '机器人无权在归档频道发送嵌入消息'
            };
        }
        
        return {
            available: true,
            channel: archiveChannel,
            error: null
        };
        
    } catch (error) {
        console.error('检查归档频道可用性时出错:', error);
        return {
            available: false,
            channel: null,
            error: error.message
        };
    }
}

/**
 * 🔥 新增：启动定时清理任务
 * @param {Client} client - Discord客户端（用于日志记录）
 */
function startAttachmentCleanupScheduler(client = null) {
    // 如果已经有定时器在运行，先清除它
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    
    // 设置每小时执行一次清理
    const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000; // 转换为毫秒
    
    cleanupTimer = setInterval(async () => {
        try {
            console.log('🧹 开始执行定时附件清理任务...');
            const result = await cleanupOldAttachments(CLEANUP_FILE_AGE_HOURS / 24); // 转换为天数
            
            if (result.deleted > 0) {
                console.log(`✅ 定时清理完成：删除了 ${result.deleted} 个旧附件文件`);
            } else {
                console.log('✅ 定时清理完成：没有需要删除的旧文件');
            }
            
            if (result.errors.length > 0) {
                console.error('⚠️ 清理过程中出现错误:', result.errors);
            }
            
        } catch (error) {
            console.error('❌ 定时清理任务执行失败:', error);
        }
    }, intervalMs);
    
    console.log(`🕐 附件清理定时器已启动：每 ${CLEANUP_INTERVAL_HOURS} 小时清理一次，删除 ${CLEANUP_FILE_AGE_HOURS} 小时前的文件`);
    
    // 立即执行一次清理（可选）
    setTimeout(async () => {
        try {
            console.log('🧹 执行初始附件清理...');
            const result = await cleanupOldAttachments(CLEANUP_FILE_AGE_HOURS / 24);
            if (result.deleted > 0) {
                console.log(`✅ 初始清理完成：删除了 ${result.deleted} 个旧附件文件`);
            }
        } catch (error) {
            console.error('❌ 初始清理失败:', error);
        }
    }, 5000); // 5秒后执行初始清理
}

/**
 * 🔥 新增：停止定时清理任务
 */
function stopAttachmentCleanupScheduler() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
        console.log('🛑 附件清理定时器已停止');
    }
}

/**
 * 🔥 修改：清理旧的附件文件（改为按小时计算）
 * @param {number} daysOld - 删除多少天前的文件（保持兼容性）
 * @returns {Promise<{deleted: number, errors: string[]}>}
 */
async function cleanupOldAttachments(daysOld = 1) {
    try {
        await ensureAttachmentsDir();
        
        const files = await fs.readdir(ATTACHMENTS_DIR);
        const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
        
        let deleted = 0;
        const errors = [];
        
        for (const file of files) {
            try {
                const filePath = path.join(ATTACHMENTS_DIR, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtime.getTime() < cutoffTime) {
                    await fs.unlink(filePath);
                    deleted++;
                    console.log(`🗑️ 删除旧附件: ${file} (创建于 ${stats.mtime.toLocaleString()})`);
                }
            } catch (error) {
                errors.push(`删除文件 ${file} 时出错: ${error.message}`);
            }
        }
        
        return { deleted, errors };
        
    } catch (error) {
        return { deleted: 0, errors: [`清理附件时出错: ${error.message}`] };
    }
}

/**
 * 🔥 新增：获取清理任务状态
 * @returns {object} 清理任务的状态信息
 */
function getCleanupStatus() {
    return {
        isRunning: cleanupTimer !== null,
        intervalHours: CLEANUP_INTERVAL_HOURS,
        fileAgeHours: CLEANUP_FILE_AGE_HOURS,
        nextCleanupTime: cleanupTimer ? new Date(Date.now() + CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000) : null
    };
}

/**
 * 获取附件文件信息
 * @param {string} filename - 文件名
 * @returns {Promise<{exists: boolean, path?: string, size?: number, error?: string}>}
 */
async function getAttachmentInfo(filename) {
    try {
        const filePath = path.join(ATTACHMENTS_DIR, filename);
        const stats = await fs.stat(filePath);
        
        return {
            exists: true,
            path: filePath,
            size: stats.size
        };
    } catch (error) {
        return {
            exists: false,
            error: error.message
        };
    }
}

module.exports = {
    archiveDeletedMessage,
    checkArchiveChannelAvailable,
    formatFileSize,
    downloadAttachment,
    cleanupOldAttachments,
    getAttachmentInfo,
    ensureAttachmentsDir,
    startAttachmentCleanupScheduler,
    stopAttachmentCleanupScheduler,
    getCleanupStatus,
    isMediaFile,
    getSpoilerFilename
};