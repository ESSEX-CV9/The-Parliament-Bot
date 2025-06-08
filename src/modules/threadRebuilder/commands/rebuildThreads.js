const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const JsonReader = require('../services/jsonReader');
const ThreadRebuilder = require('../services/threadRebuilder');
const ParallelThreadManager = require('../services/parallelThreadManager');
const config = require('../config/config');
const path = require('path');
const ProgressTracker = require('../services/progressTracker');
const XlsxGenerator = require('../services/xlsxGenerator');
const ExcelReader = require('../services/excelReader');

const data = new SlashCommandBuilder()
    .setName('重建帖子')
    .setDescription('从JSON备份文件重建Discord帖子（管理员专用）')
    .addChannelOption(option =>
        option.setName('目标论坛')
            .setDescription('要重建到的论坛频道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildForum)
    )
    .addStringOption(option =>
        option.setName('json文件名')
            .setDescription('指定要重建的JSON文件名（不含扩展名，为空则重建所有文件）')
            .setRequired(false)
    )
    .addBooleanOption(option =>
        option.setName('使用webhook')
            .setDescription('是否使用Webhook模拟原作者发送消息（默认：是）')
            .setRequired(false)
    )
    .addBooleanOption(option =>
        option.setName('并行处理')
            .setDescription('是否启用并行处理多个帖子（默认：是，可显著提升速度）')
            .setRequired(false)
    )
    .addIntegerOption(option =>
        option.setName('并发数')
            .setDescription('同时处理的帖子数量（1-5，默认：3）')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(5)
    )
    .addBooleanOption(option =>
        option.setName('自动归档')
            .setDescription('是否在重建完成后自动归档线程（默认：是）')
            .setRequired(false)
    );

// 改进的进度管理器 - 使用公开消息避免webhook token过期
class ProgressManager {
    constructor(interaction) {
        this.interaction = interaction;
        this.channel = interaction.channel;
        this.startTime = Date.now();
        this.lastUpdateTime = 0;
        this.updateThrottleMs = 5000; // 5秒更新一次，避免过于频繁的公开消息
        this.progressMessage = null; // 存储进度消息对象
        this.isInitialized = false;
    }
    
    /**
     * 初始化进度消息系统
     */
    async initialize() {
        if (this.isInitialized) return;
        
        try {
            // 先回复一个ephemeral消息确认收到命令
            await this.interaction.editReply({
                content: '🚀 **帖子重建任务已启动**\n\n进度更新将在此频道中公开显示，避免长时间任务的token过期问题。'
            });
            
            // 发送第一条公开进度消息
            this.progressMessage = await this.channel.send({
                content: '🔄 **帖子重建进行中** ⏱️ 0:00\n\n📋 正在初始化...'
            });
            
            this.isInitialized = true;
            console.log(`进度消息已初始化，消息ID: ${this.progressMessage.id}`);
            
        } catch (error) {
            console.error('初始化进度消息失败:', error);
            // 如果公开消息发送失败，回退到原来的方式
            this.isInitialized = false;
        }
    }
    
    async updateProgress(message) {
        const now = Date.now();
        
        // 节流更新，避免过于频繁
        if (now - this.lastUpdateTime < this.updateThrottleMs) {
            return;
        }
        
        this.lastUpdateTime = now;
        const elapsed = Math.floor((now - this.startTime) / 1000);
        const timeStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`;
        
        // 确保已初始化
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        const content = `🔄 **帖子重建进行中** ⏱️ ${timeStr}\n\n${message}`;
        
        try {
            if (this.progressMessage && this.isInitialized) {
                // 编辑公开进度消息
                await this.progressMessage.edit({ content });
            } else {
                // 回退到编辑interaction回复
                await this.interaction.editReply({ content });
            }
        } catch (error) {
            console.error('更新进度失败:', error);
            
            // 如果编辑消息失败，尝试发送新消息
            if (this.isInitialized && error.code === 10008) { // Unknown Message
                try {
                    this.progressMessage = await this.channel.send({ content });
                } catch (sendError) {
                    console.error('发送新进度消息失败:', sendError);
                }
            }
        }
    }
    
    async complete(summary) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const timeStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`;
        
        const content = `✅ **帖子重建完成** ⏱️ 总用时: ${timeStr}\n\n${summary}`;
        
        try {
            if (this.progressMessage && this.isInitialized) {
                // 编辑公开进度消息为完成状态
                await this.progressMessage.edit({ content });
                
                // 同时更新原始交互回复
                try {
                    await this.interaction.editReply({
                        content: `✅ **任务完成！** 详细信息请查看上方的公开消息。`
                    });
                } catch (interactionError) {
                    console.log('更新交互回复失败（这是正常的，token可能已过期）:', interactionError.message);
                }
            } else {
                // 回退到编辑interaction回复
                await this.interaction.editReply({ content });
            }
        } catch (error) {
            console.error('完成更新失败:', error);
            
            // 如果编辑失败，尝试发送新的完成消息
            if (this.isInitialized) {
                try {
                    await this.channel.send({ content });
                } catch (sendError) {
                    console.error('发送完成消息失败:', sendError);
                }
            }
        }
    }
    
    /**
     * 发送错误消息
     */
    async sendError(errorMessage) {
        const content = `❌ **帖子重建失败**\n\n${errorMessage}`;
        
        try {
            if (this.progressMessage && this.isInitialized) {
                await this.progressMessage.edit({ content });
            } else {
                await this.interaction.editReply({ content });
            }
        } catch (error) {
            console.error('发送错误消息失败:', error);
            if (this.isInitialized) {
                try {
                    await this.channel.send({ content });
                } catch (sendError) {
                    console.error('发送新错误消息失败:', sendError);
                }
            }
        }
    }
}

async function execute(interaction) {
    try {
        // 检查管理员权限
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        const targetForum = interaction.options.getChannel('目标论坛');
        const specificFile = interaction.options.getString('json文件名');
        const useWebhook = interaction.options.getBoolean('使用webhook') !== false;
        const enableParallel = interaction.options.getBoolean('并行处理') !== false;
        const concurrency = interaction.options.getInteger('并发数') || config.parallel.maxConcurrentThreads;
        const autoArchive = interaction.options.getBoolean('自动归档') !== false;
        
        // 验证目标论坛
        if (targetForum.type !== ChannelType.GuildForum) {
            return interaction.reply({
                content: '❌ 指定的频道不是论坛频道！',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 创建进度管理器
        const progressManager = new ProgressManager(interaction);
        
        try {
            // 延迟回复以获得更多时间
            await interaction.deferReply({ ephemeral: true });
            
            // 初始化进度管理器
            await progressManager.initialize();
            
            // 创建全局的Excel读取器，只初始化一次
            const globalExcelReader = new ExcelReader();
            let excelDataLoaded = false;
            
            // 首先加载Excel数据
            await progressManager.updateProgress('📊 正在加载Excel数据...');
            try {
                await globalExcelReader.loadExcelData();
                excelDataLoaded = true;
                await progressManager.updateProgress('✅ Excel数据加载完成');
            } catch (error) {
                console.warn('Excel数据加载失败，将使用默认流程:', error);
                await progressManager.updateProgress('⚠️ Excel数据加载失败，使用默认流程继续');
                excelDataLoaded = false;
            }
            
            // 显示内容过滤器状态（新增）
            await progressManager.updateProgress('🔍 正在初始化内容过滤器...');
            try {
                const jsonReader = new JsonReader();
                await jsonReader.initializeContentFilter();
                const filterStats = jsonReader.contentFilter.getFilterStats();
                if (filterStats.enabled) {
                    await progressManager.updateProgress(`✅ 内容过滤器已启用 (关键词: ${filterStats.keywordCount}, 模式: ${filterStats.patternCount})`);
                } else {
                    await progressManager.updateProgress('⚠️ 内容过滤器已禁用');
                }
            } catch (error) {
                console.warn('内容过滤器初始化失败:', error);
                await progressManager.updateProgress('⚠️ 内容过滤器初始化失败，继续重建...');
            }
            
            // 初始化其他组件
            const jsonReader = new JsonReader();
            const threadRebuilder = new ThreadRebuilder(targetForum, useWebhook);
            const progressTracker = new ProgressTracker();
            
            // 如果Excel数据加载成功，设置到ThreadRebuilder中并创建标签
            if (excelDataLoaded) {
                threadRebuilder.setExcelReader(globalExcelReader);
                threadRebuilder.setExcelDataLoaded(true);
                
                await progressManager.updateProgress('🏷️ 正在创建论坛标签...');
                try {
                    await threadRebuilder.createForumTags();
                    await progressManager.updateProgress('✅ 标签创建完成，开始重建帖子...');
                } catch (error) {
                    console.warn('创建标签失败:', error);
                    await progressManager.updateProgress('⚠️ 标签创建失败，继续重建帖子...');
                }
            }
            
            // 检查是否有未完成的会话
            const hasUnfinished = await progressTracker.hasUnfinishedSession();
            if (hasUnfinished) {
                const sessionInfo = await progressTracker.getUnfinishedSessionInfo();
                await progressManager.updateProgress(
                    `🔄 发现未完成的会话: ${sessionInfo.sessionId}\n` +
                    `📊 进度: ${sessionInfo.stats.completedFiles + sessionInfo.stats.failedFiles + sessionInfo.stats.skippedFiles}/${sessionInfo.stats.totalFiles}\n` +
                    `⏰ 开始时间: ${new Date(sessionInfo.startTime).toLocaleString()}\n` +
                    `🚀 正在从断点继续...`
                );
            }
            
            // 1. 读取和验证JSON文件
            await progressManager.updateProgress('📂 正在扫描和验证JSON文件...');
            
            const jsonFiles = await jsonReader.getJsonFiles(specificFile);
            
            if (jsonFiles.length === 0) {
                await progressManager.complete('❌ 没有找到要处理的JSON文件！');
                return;
            }
            
            // 验证JSON文件有效性
            const validJsonFiles = await jsonReader.validateMultipleJsonFiles(jsonFiles);
            
            if (validJsonFiles.length === 0) {
                await progressManager.complete('❌ 没有找到有效的JSON文件！');
                return;
            }
            
            // 2. 初始化进度跟踪
            const sessionId = await progressTracker.initSession(validJsonFiles);
            const pendingFiles = progressTracker.getPendingFiles();
            const completedFiles = progressTracker.getCompletedFiles();
            
            console.log(`会话 ${sessionId}: 待处理 ${pendingFiles.length} 个文件，已完成 ${completedFiles.length} 个文件`);
            
            if (pendingFiles.length === 0) {
                // 所有文件都已完成
                const xlsxGenerator = new XlsxGenerator();
                const report = await xlsxGenerator.generateRebuildReport(progressTracker, sessionId);
                
                await progressManager.complete(
                    `✅ 所有文件已完成处理！\n\n` +
                    `📊 详细报告已生成: ${report.fileName}\n` +
                    `📁 报告路径: ${path.relative(process.cwd(), report.filePath)}`
                );
                
                await progressTracker.clearProgress();
                return;
            }
            
            const processingMode = enableParallel ? '并行' : '串行';
            await progressManager.updateProgress(
                `📝 会话: ${sessionId}\n` +
                `📁 总文件: ${validJsonFiles.length}，待处理: ${pendingFiles.length}\n` +
                `🔧 处理模式: ${processingMode}\n` +
                `${enableParallel ? `⚡ 并发数: ${concurrency}\n` : ''}` +
                `🚀 开始处理...`
            );
            
            let results = [];
            
            if (enableParallel && pendingFiles.length > 1) {
                // 并行处理模式
                results = await processParallelWithProgress(pendingFiles, targetForum, useWebhook, concurrency, progressManager, progressTracker, autoArchive, excelDataLoaded ? globalExcelReader : null);
            } else {
                // 串行处理模式
                results = await processSerialWithProgress(pendingFiles, targetForum, useWebhook, progressManager, progressTracker, autoArchive, excelDataLoaded ? globalExcelReader : null);
            }
            
            // 3. 生成XLSX报告
            const xlsxGenerator = new XlsxGenerator();
            const report = await xlsxGenerator.generateRebuildReport(progressTracker, sessionId);
            
            // 4. 生成最终汇总
            const summary = generateFinalSummary(progressTracker.getProgressStats(), report);
            await progressManager.complete(summary);
            
            // 5. 清理进度文件
            await progressTracker.clearProgress();
            
        } catch (error) {
            console.error('重建任务执行失败:', error);
            await progressManager.sendError(`执行失败: ${error.message}`);
        }
        
    } catch (error) {
        console.error('命令处理失败:', error);
        
        const errorMessage = `命令处理失败: ${error.message}`;
        
        if (interaction.deferred) {
            await interaction.editReply({ content: errorMessage });
        } else {
            await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
        }
    }
}

/**
 * 并行处理（支持进度跟踪和断点重启）
 */
async function processParallelWithProgress(jsonFiles, targetForum, useWebhook, concurrency, progressManager, progressTracker, autoArchive = true, globalExcelReader = null) {
    console.log(`启动并行处理模式，并发数: ${concurrency}`);
    
    // 打印断点重启状态
    progressTracker.printResumeStatus();
    
    // 1. 并行读取所有JSON文件
    await progressManager.updateProgress('📖 并行读取JSON文件数据...');
    
    const jsonReader = new JsonReader();
    const allThreadsData = await jsonReader.readMultipleThreadsData(
        jsonFiles, 
        config.parallel.maxConcurrentFileReads
    );
    
    if (allThreadsData.length === 0) {
        throw new Error('没有成功读取到任何帖子数据');
    }
    
    // 2. 为每个帖子数据添加断点重启信息
    for (const threadData of allThreadsData) {
        const fileName = threadData.fileName;
        const resumeInfo = progressTracker.getFileResumeInfo(fileName);
        
        if (resumeInfo) {
            threadData.resumeInfo = resumeInfo;
            
            if (resumeInfo.canResume) {
                console.log(`📄 ${fileName}: 🔄 可从断点恢复 (${resumeInfo.processedMessages}/${resumeInfo.totalMessages} 条消息)`);
            } else if (resumeInfo.threadCreated) {
                console.log(`📄 ${fileName}: 🧵 帖子已创建，将继续处理剩余消息`);
            } else {
                console.log(`📄 ${fileName}: 🆕 新文件，从头开始处理`);
            }
        } else {
            console.log(`📄 ${fileName}: 🆕 新文件，从头开始处理`);
        }
    }
    
    // 3. 使用带进度跟踪的并行管理器处理帖子
    const parallelManager = new ParallelThreadManager(targetForum, useWebhook, concurrency, progressTracker);
    
    // 设置Excel读取器
    if (globalExcelReader) {
        parallelManager.setExcelReader(globalExcelReader);
    }
    
    // 设置自动归档选项
    parallelManager.setAutoArchive(autoArchive);
    
    const results = await parallelManager.processMultipleThreads(
        allThreadsData,
        (progress) => {
            progressManager.updateProgress(progress).catch(err => 
                console.log('进度更新失败:', err.message)
            );
        }
    );
    
    return results;
}

/**
 * 串行处理（支持进度跟踪和断点重启）
 */
async function processSerialWithProgress(jsonFiles, targetForum, useWebhook, progressManager, progressTracker, autoArchive = true, globalExcelReader = null) {
    console.log('使用串行处理模式');
    
    const jsonReader = new JsonReader();
    
    for (let i = 0; i < jsonFiles.length; i++) {
        const jsonFile = jsonFiles[i];
        const progress = `[${i + 1}/${jsonFiles.length}]`;
        
        // 获取断点重启信息
        const resumeInfo = progressTracker.getFileResumeInfo(jsonFile.name);
        
        // 标记开始处理（如果不是恢复）
        if (!resumeInfo || !resumeInfo.canResume) {
            await progressTracker.markFileProcessing(jsonFile.name);
        }
        
        try {
            await progressManager.updateProgress(`${progress} 📖 读取文件: ${jsonFile.name}...`);
            
            const threadData = await jsonReader.readThreadData(jsonFile.path);
            threadData.fileName = jsonFile.name;
            threadData.resumeInfo = resumeInfo;
            
            await progressManager.updateProgress(`${progress} 🔨 重建帖子: ${threadData.threadInfo.title}...`);
            
            const rebuilder = new ThreadRebuilder(targetForum, useWebhook);
            rebuilder.setProgressTracker(progressTracker);
            
            // 设置Excel读取器
            if (globalExcelReader) {
                rebuilder.setExcelReader(globalExcelReader);
                rebuilder.setExcelDataLoaded(true);
            }
            
            const result = await rebuilder.rebuildThread(
                threadData,
                (current, total) => {
                    const percentage = Math.round((current / total) * 100);
                    progressManager.updateProgress(`${progress} 📝 ${threadData.threadInfo.title}: ${current}/${total} (${percentage}%)`).catch(() => {});
                },
                resumeInfo
            );
            
            // 自动归档
            if (autoArchive && result.id) {
                try {
                    const thread = await targetForum.threads.fetch(result.id);
                    await thread.setArchived(true);
                    console.log(`✅ 帖子已归档: ${result.name}`);
                } catch (archiveError) {
                    console.warn(`⚠️ 归档失败: ${result.name}`, archiveError);
                }
            }
            
            await progressTracker.markFileCompleted(jsonFile.name, result.id, result.name, result.messagesProcessed);
            await progressManager.updateProgress(`${progress} ✅ 完成: ${result.name}`);
            
        } catch (error) {
            console.error(`处理文件失败: ${jsonFile.name}`, error);
            await progressTracker.markFileFailed(jsonFile.name, error.message);
            await progressManager.updateProgress(`${progress} ❌ 失败: ${jsonFile.name} - ${error.message}`);
        }
    }
    
    return [];
}

/**
 * 生成最终汇总（简化版，主要信息在XLSX中）
 */
function generateFinalSummary(stats, report) {
    let summary = `📊 **重建任务完成**\n\n`;
    summary += `🏷️ 会话ID: ${stats.sessionId}\n`;
    summary += `📁 总文件数: ${stats.totalFiles}\n`;
    summary += `✅ 成功: ${stats.completedFiles}\n`;
    summary += `❌ 失败: ${stats.failedFiles}\n`;
    summary += `⏭️ 跳过: ${stats.skippedFiles}\n`;
    summary += `📈 成功率: ${stats.progressPercentage}%\n\n`;
    summary += `📋 **详细报告**\n`;
    summary += `📄 文件名: ${report.fileName}\n`;
    summary += `📁 路径: ${path.relative(process.cwd(), report.filePath)}\n\n`;
    summary += `💡 请查看Excel文件获取详细的处理结果`;
    
    return summary;
}

module.exports = {
    data,
    execute
}; 