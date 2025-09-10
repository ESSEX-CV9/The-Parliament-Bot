const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { 
    startAttachmentCleanupScheduler, 
    stopAttachmentCleanupScheduler, 
    getCleanupStatus,
    cleanupOldAttachments,
    formatFileSize
} = require('../services/archiveService');
const fs = require('fs').promises;
const path = require('path');

const ATTACHMENTS_DIR = path.join(__dirname, '../../../../data/attachments');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('搬石公投-管理附件清理')
        .setDescription('管理附件清理任务')
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('查看清理任务状态')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('启动定时清理任务')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('停止定时清理任务')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('cleanup-now')
                .setDescription('立即执行一次清理')
                .addIntegerOption(option =>
                    option
                        .setName('hours')
                        .setDescription('删除多少小时前的文件（默认24小时）')
                        .setMinValue(1)
                        .setMaxValue(168) // 最多7天
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('查看附件存储信息')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'status':
                    await handleStatus(interaction);
                    break;
                case 'start':
                    await handleStart(interaction);
                    break;
                case 'stop':
                    await handleStop(interaction);
                    break;
                case 'cleanup-now':
                    await handleCleanupNow(interaction);
                    break;
                case 'info':
                    await handleInfo(interaction);
                    break;
                default:
                    await interaction.reply({
                        content: '❌ 未知的子命令',
                        ephemeral: true
                    });
            }
        } catch (error) {
            console.error('执行附件清理管理命令时出错:', error);
            
            const errorMessage = '❌ 执行命令时出现错误，请稍后重试';
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    }
};

async function handleStatus(interaction) {
    const status = getCleanupStatus();
    
    const embed = new EmbedBuilder()
        .setTitle('🧹 附件清理任务状态')
        .setColor(status.isRunning ? '#00FF00' : '#FF6B6B')
        .addFields(
            {
                name: '📊 运行状态',
                value: status.isRunning ? '✅ 正在运行' : '❌ 已停止',
                inline: true
            },
            {
                name: '⏰ 清理间隔',
                value: `${status.intervalHours} 小时`,
                inline: true
            },
            {
                name: '🗂️ 文件保留时间',
                value: `${status.fileAgeHours} 小时`,
                inline: true
            }
        )
        .setTimestamp();
    
    if (status.isRunning && status.nextCleanupTime) {
        embed.addFields({
            name: '⏭️ 下次清理时间',
            value: `<t:${Math.floor(status.nextCleanupTime.getTime() / 1000)}:R>`,
            inline: false
        });
    }
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleStart(interaction) {
    const status = getCleanupStatus();
    
    if (status.isRunning) {
        await interaction.reply({
            content: '⚠️ 清理任务已经在运行中',
            ephemeral: true
        });
        return;
    }
    
    startAttachmentCleanupScheduler(interaction.client);
    
    await interaction.reply({
        content: '✅ 附件清理定时任务已启动！每小时将自动清理24小时前的附件文件。',
        ephemeral: true
    });
}

async function handleStop(interaction) {
    const status = getCleanupStatus();
    
    if (!status.isRunning) {
        await interaction.reply({
            content: '⚠️ 清理任务当前未运行',
            ephemeral: true
        });
        return;
    }
    
    stopAttachmentCleanupScheduler();
    
    await interaction.reply({
        content: '🛑 附件清理定时任务已停止',
        ephemeral: true
    });
}

async function handleCleanupNow(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const hours = interaction.options.getInteger('hours') || 24;
    const days = hours / 24;
    
    try {
        const result = await cleanupOldAttachments(days);
        
        const embed = new EmbedBuilder()
            .setTitle('🧹 手动清理完成')
            .setColor('#00FF00')
            .addFields(
                {
                    name: '🗑️ 删除的文件数量',
                    value: `${result.deleted} 个`,
                    inline: true
                },
                {
                    name: '⏰ 清理条件',
                    value: `删除 ${hours} 小时前的文件`,
                    inline: true
                }
            )
            .setTimestamp();
        
        if (result.errors.length > 0) {
            embed.addFields({
                name: '⚠️ 错误信息',
                value: result.errors.slice(0, 5).join('\n') + (result.errors.length > 5 ? '\n...' : ''),
                inline: false
            });
            embed.setColor('#FF8C00');
        }
        
        await interaction.editReply({ embeds: [embed] });
        
    } catch (error) {
        await interaction.editReply({
            content: `❌ 清理失败: ${error.message}`
        });
    }
}

async function handleInfo(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    try {
        // 检查附件目录是否存在
        let totalFiles = 0;
        let totalSize = 0;
        let oldestFile = null;
        let newestFile = null;
        
        try {
            const files = await fs.readdir(ATTACHMENTS_DIR);
            totalFiles = files.length;
            
            for (const file of files) {
                try {
                    const filePath = path.join(ATTACHMENTS_DIR, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                    
                    if (!oldestFile || stats.mtime < oldestFile.time) {
                        oldestFile = { name: file, time: stats.mtime };
                    }
                    
                    if (!newestFile || stats.mtime > newestFile.time) {
                        newestFile = { name: file, time: stats.mtime };
                    }
                } catch (error) {
                    // 忽略单个文件的错误
                }
            }
        } catch (error) {
            // 目录不存在或无法访问
        }
        
        const embed = new EmbedBuilder()
            .setTitle('📁 附件存储信息')
            .setColor('#0099FF')
            .addFields(
                {
                    name: '📊 文件统计',
                    value: `总文件数: ${totalFiles}\n总大小: ${formatFileSize(totalSize)}`,
                    inline: true
                },
                {
                    name: '📍 存储位置',
                    value: `\`${ATTACHMENTS_DIR}\``,
                    inline: false
                }
            )
            .setTimestamp();
        
        if (oldestFile) {
            embed.addFields({
                name: '📅 最旧文件',
                value: `${oldestFile.name}\n<t:${Math.floor(oldestFile.time.getTime() / 1000)}:R>`,
                inline: true
            });
        }
        
        if (newestFile) {
            embed.addFields({
                name: '🆕 最新文件',
                value: `${newestFile.name}\n<t:${Math.floor(newestFile.time.getTime() / 1000)}:R>`,
                inline: true
            });
        }
        
        await interaction.editReply({ embeds: [embed] });
        
    } catch (error) {
        await interaction.editReply({
            content: `❌ 获取附件信息失败: ${error.message}`
        });
    }
} 