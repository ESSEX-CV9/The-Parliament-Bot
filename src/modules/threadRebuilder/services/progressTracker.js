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
            files: {} // fileName -> { status, threadId, error, completedAt, messagesCount }
        };
    }

    /**
     * 初始化新的处理会话
     */
    async initSession(jsonFiles, sessionId = null) {
        this.currentSession = sessionId || `session_${Date.now()}`;
        
        // 尝试加载现有进度
        const existingProgress = await this.loadProgress();
        
        if (existingProgress && existingProgress.sessionId === this.currentSession) {
            // 恢复现有会话
            this.progress = existingProgress;
            console.log(`恢复会话: ${this.currentSession}，已完成 ${this.progress.completedFiles}/${this.progress.totalFiles} 个文件`);
        } else {
            // 创建新会话
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
                this.progress.files[file.name] = {
                    status: 'pending', // pending, processing, completed, failed, skipped
                    threadId: null,
                    threadName: null,
                    error: null,
                    completedAt: null,
                    messagesCount: 0,
                    filePath: file.path
                };
            });
            
            console.log(`创建新会话: ${this.currentSession}，共 ${jsonFiles.length} 个文件`);
        }
        
        await this.saveProgress();
        return this.currentSession;
    }

    /**
     * 获取待处理的文件列表
     */
    getPendingFiles() {
        return Object.entries(this.progress.files)
            .filter(([fileName, fileInfo]) => fileInfo.status === 'pending')
            .map(([fileName, fileInfo]) => ({
                name: fileName,
                path: fileInfo.filePath
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
     * 标记文件处理完成
     */
    async markFileCompleted(fileName, result) {
        if (this.progress.files[fileName]) {
            this.progress.files[fileName].status = 'completed';
            this.progress.files[fileName].threadId = result.threadId;
            this.progress.files[fileName].threadName = result.threadName;
            this.progress.files[fileName].messagesCount = result.messagesCount || 0;
            this.progress.files[fileName].completedAt = new Date().toISOString();
            
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
            skipReason: fileInfo.skipReason
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
        
        const stats = this.getProgressStats();
        return {
            sessionId: progress.sessionId,
            startTime: progress.startTime,
            stats: stats,
            canResume: stats.pendingFiles > 0
        };
    }
}

module.exports = ProgressTracker; 