const fs = require('fs').promises;
const path = require('path');

/**
 * 进度跟踪器 - 管理重建进度的记录和恢复
 */
class ProgressTracker {
    constructor() {
        this.dataDir = path.resolve(process.cwd(), 'data/rebuild');
        this.progressFile = path.join(this.dataDir, 'rebuild-progress.json');
        this.currentSession = null;
        this.progress = {
            sessionId: '',
            startTime: null,
            lastUpdateTime: null,
            totalFiles: 0,
            completedFiles: 0,
            failedFiles: 0,
            skippedFiles: 0,
            files: {} // fileName -> { status, threadId, error, completedAt, messagesCount, resumeInfo }
        };
    }

    /**
     * 初始化会话 - 修复断点重启逻辑
     */
    async initSession(jsonFiles, sessionId = null) {
        // 尝试加载现有进度
        const existingProgress = await this.loadProgress();
        
        if (existingProgress) {
            // 检查现有进度是否包含当前文件列表
            const existingFileNames = new Set(Object.keys(existingProgress.files));
            const currentFileNames = new Set(jsonFiles.map(f => f.name));
            
            // 计算文件集合的相似度
            const intersection = new Set([...existingFileNames].filter(f => currentFileNames.has(f)));
            const similarity = intersection.size / Math.max(existingFileNames.size, currentFileNames.size);
            
            // 如果文件集合相似度大于80%，认为是同一批任务，进行断点恢复
            if (similarity > 0.8) {
                console.log(`🔄 检测到现有进度文件，相似度: ${Math.round(similarity * 100)}%`);
                this.progress = existingProgress;
                this.currentSession = existingProgress.sessionId;
                
                // 更新文件路径（可能文件路径发生了变化）
                jsonFiles.forEach(file => {
                    if (this.progress.files[file.name]) {
                        this.progress.files[file.name].filePath = file.path;
                    } else {
                        // 添加新文件
                        this.progress.files[file.name] = this.createNewFileEntry(file);
                        this.progress.totalFiles++;
                    }
                });
                
                // 移除不存在的文件
                for (const fileName of Object.keys(this.progress.files)) {
                    if (!currentFileNames.has(fileName)) {
                        console.log(`⚠️ 文件 ${fileName} 不在当前批次中，将跳过`);
                        delete this.progress.files[fileName];
                        this.progress.totalFiles--;
                    }
                }
                
                this.progress.lastUpdateTime = new Date().toISOString();
                await this.saveProgress();
                
                console.log(`✅ 恢复会话: ${this.currentSession}`);
                console.log(`📊 总文件: ${this.progress.totalFiles}, 已完成: ${this.progress.completedFiles}, 失败: ${this.progress.failedFiles}`);
                
                return this.currentSession;
            } else {
                console.log(`⚠️ 现有进度文件与当前任务相似度较低(${Math.round(similarity * 100)}%)，将创建新会话`);
                // 备份现有进度文件
                await this.backupExistingProgress();
            }
        }
        
        // 创建新会话
        this.currentSession = sessionId || `session_${Date.now()}`;
        this.progress = {
            sessionId: this.currentSession,
            startTime: new Date().toISOString(),
            lastUpdateTime: new Date().toISOString(),
            totalFiles: jsonFiles.length,
            completedFiles: 0,
            failedFiles: 0,
            skippedFiles: 0,
            files: {}
        };
        
        // 初始化所有文件状态
        jsonFiles.forEach(file => {
            this.progress.files[file.name] = this.createNewFileEntry(file);
        });
        
        await this.saveProgress();
        console.log(`🆕 创建新会话: ${this.currentSession}，共 ${jsonFiles.length} 个文件`);
        
        return this.currentSession;
    }

    /**
     * 创建新的文件条目
     */
    createNewFileEntry(file) {
        return {
            status: 'pending', // pending, processing, completed, failed, skipped
            threadId: null,
            threadName: null,
            error: null,
            completedAt: null,
            messagesCount: 0,
            filePath: file.path,
            // 断点重启信息
            resumeInfo: {
                threadCreated: false,
                lastProcessedMessageId: null,
                lastProcessedMessageIndex: -1,
                totalMessages: 0,
                processedMessages: 0
            }
        };
    }

    /**
     * 备份现有进度文件
     */
    async backupExistingProgress() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(this.dataDir, `rebuild-progress-backup-${timestamp}.json`);
            
            const existingContent = await fs.readFile(this.progressFile, 'utf8');
            await fs.writeFile(backupFile, existingContent, 'utf8');
            
            console.log(`📦 已备份现有进度文件: ${path.basename(backupFile)}`);
        } catch (error) {
            console.warn(`⚠️ 备份进度文件失败: ${error.message}`);
        }
    }

    /**
     * 获取待处理的文件列表（包括部分完成的文件）
     */
    getPendingFiles() {
        return Object.entries(this.progress.files)
            .filter(([fileName, fileInfo]) => {
                return fileInfo.status === 'pending' || 
                       (fileInfo.status === 'processing' && fileInfo.resumeInfo && fileInfo.resumeInfo.threadCreated);
            })
            .map(([fileName, fileInfo]) => ({
                name: fileName,
                path: fileInfo.filePath,
                resumeInfo: fileInfo.resumeInfo || null
            }));
    }

    /**
     * 获取已完成的文件列表
     */
    getCompletedFiles() {
        return Object.entries(this.progress.files)
            .filter(([fileName, fileInfo]) => fileInfo.status === 'completed')
            .map(([fileName, fileInfo]) => ({
                name: fileName,
                ...fileInfo
            }));
    }

    /**
     * 标记文件开始处理
     */
    async markFileProcessing(fileName) {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].status = 'processing';
            this.progress.files[fileName].startedAt = new Date().toISOString();
            await this.saveProgress();
        }
    }

    /**
     * 更新帖子创建信息
     */
    async updateThreadCreated(fileName, threadId, threadName, totalMessages) {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].threadId = threadId;
            this.progress.files[fileName].threadName = threadName;
            
            if (!this.progress.files[fileName].resumeInfo) {
                this.progress.files[fileName].resumeInfo = {
                    threadCreated: false,
                    lastProcessedMessageId: null,
                    lastProcessedMessageIndex: -1,
                    totalMessages: 0,
                    processedMessages: 0
                };
            }
            
            this.progress.files[fileName].resumeInfo.threadCreated = true;
            this.progress.files[fileName].resumeInfo.totalMessages = totalMessages;
            this.progress.lastUpdateTime = new Date().toISOString();
            
            await this.saveProgress();
            console.log(`🧵 帖子已创建: ${fileName} -> ${threadId} (${threadName})`);
        }
    }

    /**
     * 更新消息处理进度
     */
    async updateMessageProgress(fileName, messageId, messageIndex, processedCount) {
        if (this.progress.files[fileName] && this.progress.files[fileName].resumeInfo) {
            this.progress.files[fileName].resumeInfo.lastProcessedMessageId = messageId;
            this.progress.files[fileName].resumeInfo.lastProcessedMessageIndex = messageIndex;
            this.progress.files[fileName].resumeInfo.processedMessages = processedCount;
            this.progress.lastUpdateTime = new Date().toISOString();
            
            // 每处理10条消息保存一次进度，避免频繁写入
            if (processedCount % 10 === 0) {
                await this.saveProgress();
            }
        }
    }

    /**
     * 标记文件处理完成
     */
    async markFileCompleted(fileName, result) {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].status = 'completed';
            this.progress.files[fileName].threadId = result.threadId;
            this.progress.files[fileName].threadName = result.threadName;
            this.progress.files[fileName].messagesCount = result.messagesCount || 0;
            this.progress.files[fileName].completedAt = new Date().toISOString();
            
            // 更新完成信息
            if (this.progress.files[fileName].resumeInfo) {
                this.progress.files[fileName].resumeInfo.processedMessages = result.messagesCount || 0;
            }
            
            this.progress.completedFiles++;
            this.progress.lastUpdateTime = new Date().toISOString();
            
            await this.saveProgress();
            console.log(`✅ 文件完成: ${fileName} (${this.progress.completedFiles}/${this.progress.totalFiles})`);
        }
    }

    /**
     * 标记文件处理失败
     */
    async markFileFailed(fileName, error) {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].status = 'failed';
            this.progress.files[fileName].error = error;
            this.progress.files[fileName].failedAt = new Date().toISOString();
            
            this.progress.failedFiles++;
            this.progress.lastUpdateTime = new Date().toISOString();
            
            await this.saveProgress();
            console.log(`❌ 文件失败: ${fileName} - ${error}`);
        }
    }

    /**
     * 标记文件被跳过
     */
    async markFileSkipped(fileName, reason = '已存在') {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].status = 'skipped';
            this.progress.files[fileName].skipReason = reason;
            this.progress.files[fileName].skippedAt = new Date().toISOString();
            
            this.progress.skippedFiles++;
            this.progress.lastUpdateTime = new Date().toISOString();
            
            await this.saveProgress();
            console.log(`⏭️ 文件跳过: ${fileName} - ${reason}`);
        }
    }

    /**
     * 获取文件的断点重启信息
     */
    getFileResumeInfo(fileName) {
        const fileInfo = this.progress.files[fileName];
        if (!fileInfo || !fileInfo.resumeInfo) {
            return null;
        }

        const resumeInfo = fileInfo.resumeInfo;
        return {
            threadId: fileInfo.threadId,
            threadName: fileInfo.threadName,
            threadCreated: resumeInfo.threadCreated,
            lastProcessedMessageId: resumeInfo.lastProcessedMessageId,
            lastProcessedMessageIndex: resumeInfo.lastProcessedMessageIndex,
            totalMessages: resumeInfo.totalMessages,
            processedMessages: resumeInfo.processedMessages,
            canResume: resumeInfo.threadCreated && resumeInfo.lastProcessedMessageIndex >= 0
        };
    }

    /**
     * 检查帖子是否已存在
     */
    async checkThreadExists(fileName) {
        const fileInfo = this.progress.files[fileName];
        if (!fileInfo || !fileInfo.resumeInfo || !fileInfo.resumeInfo.threadCreated) {
            return null;
        }

        return {
            threadId: fileInfo.threadId,
            threadName: fileInfo.threadName,
            processedMessages: fileInfo.resumeInfo.processedMessages,
            totalMessages: fileInfo.resumeInfo.totalMessages
        };
    }

    /**
     * 保存进度到文件
     */
    async saveProgress() {
        try {
            // 确保数据目录存在
            await fs.mkdir(this.dataDir, { recursive: true });
            
            // 保存进度文件
            await fs.writeFile(
                this.progressFile, 
                JSON.stringify(this.progress, null, 2), 
                'utf8'
            );
        } catch (error) {
            console.error('保存进度文件失败:', error);
        }
    }

    /**
     * 加载进度文件
     */
    async loadProgress() {
        try {
            const data = await fs.readFile(this.progressFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('加载进度文件失败:', error);
            }
            return null;
        }
    }

    /**
     * 获取进度统计
     */
    getProgressStats() {
        const pending = Object.values(this.progress.files).filter(f => f.status === 'pending').length;
        const processing = Object.values(this.progress.files).filter(f => f.status === 'processing').length;
        
        return {
            sessionId: this.progress.sessionId,
            startTime: this.progress.startTime,
            lastUpdateTime: this.progress.lastUpdateTime,
            totalFiles: this.progress.totalFiles,
            completedFiles: this.progress.completedFiles,
            failedFiles: this.progress.failedFiles,
            skippedFiles: this.progress.skippedFiles,
            pendingFiles: pending,
            processingFiles: processing,
            progressPercentage: this.progress.totalFiles > 0 ? 
                Math.round(((this.progress.completedFiles + this.progress.failedFiles + this.progress.skippedFiles) / this.progress.totalFiles) * 100) : 0
        };
    }

    /**
     * 清理进度文件（处理完成后）
     */
    async clearProgress() {
        try {
            await fs.unlink(this.progressFile);
            console.log('进度文件已清理');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('清理进度文件失败:', error);
            }
        }
    }

    /**
     * 获取详细的文件状态列表
     */
    getDetailedFileStatus() {
        return Object.entries(this.progress.files).map(([fileName, fileInfo]) => ({
            fileName,
            status: fileInfo.status,
            threadId: fileInfo.threadId,
            threadName: fileInfo.threadName,
            messagesCount: fileInfo.messagesCount || 0,
            error: fileInfo.error,
            completedAt: fileInfo.completedAt,
            failedAt: fileInfo.failedAt,
            skippedAt: fileInfo.skippedAt,
            skipReason: fileInfo.skipReason,
            resumeInfo: fileInfo.resumeInfo
        }));
    }

    /**
     * 检查是否有未完成的会话
     */
    async hasUnfinishedSession() {
        const progress = await this.loadProgress();
        if (!progress) return false;
        
        const stats = {
            totalFiles: progress.totalFiles,
            completedFiles: progress.completedFiles,
            failedFiles: progress.failedFiles,
            skippedFiles: progress.skippedFiles
        };
        
        const finishedFiles = stats.completedFiles + stats.failedFiles + stats.skippedFiles;
        return finishedFiles < stats.totalFiles;
    }

    /**
     * 获取未完成会话的信息
     */
    async getUnfinishedSessionInfo() {
        const progress = await this.loadProgress();
        if (!progress) return null;
        
        // 临时设置progress以便计算统计信息
        const tempProgress = this.progress;
        this.progress = progress;
        const stats = this.getProgressStats();
        this.progress = tempProgress;
        
        const partiallyCompletedFiles = Object.values(progress.files).filter(f => 
            f.status === 'processing' && f.resumeInfo && f.resumeInfo.threadCreated
        ).length;
        
        return {
            sessionId: progress.sessionId,
            startTime: progress.startTime,
            stats: stats,
            canResume: stats.pendingFiles > 0 || partiallyCompletedFiles > 0,
            partiallyCompletedFiles: partiallyCompletedFiles
        };
    }

    /**
     * 打印断点重启状态
     */
    printResumeStatus() {
        const pendingFiles = this.getPendingFiles();
        const resumableFiles = pendingFiles.filter(f => f.resumeInfo && f.resumeInfo.canResume);
        
        console.log(`📊 断点重启状态:`);
        console.log(`   总文件: ${this.progress.totalFiles}`);
        console.log(`   已完成: ${this.progress.completedFiles}`);
        console.log(`   失败: ${this.progress.failedFiles}`);
        console.log(`   待处理: ${pendingFiles.length}`);
        console.log(`   可恢复: ${resumableFiles.length}`);
        
        if (resumableFiles.length > 0) {
            console.log(`🔄 可恢复的文件:`);
            resumableFiles.forEach(file => {
                const progress = file.resumeInfo.processedMessages || 0;
                const total = file.resumeInfo.totalMessages || 0;
                console.log(`   - ${file.name}: ${progress}/${total} 条消息`);
            });
        }
    }
}

module.exports = ProgressTracker; 