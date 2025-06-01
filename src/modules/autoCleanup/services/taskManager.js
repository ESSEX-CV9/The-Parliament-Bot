const { getActiveCleanupTask, saveCleanupTask, updateCleanupTask, deleteCleanupTask } = require('../../../core/utils/database');

class TaskManager {
    constructor() {
        this.tasks = new Map(); // guildId -> activeTask
        this.pausedAutoCleanup = new Set(); // 暂停自动清理的服务器
    }

    async startFullServerScan(guild, options = {}) {
        const guildId = guild.id;
        
        // 检查是否已有活跃任务
        const existingTask = await this.getActiveTask(guildId);
        if (existingTask) {
            throw new Error('服务器已有正在进行的清理任务');
        }

        // 创建新任务
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const taskData = {
            taskId,
            guildId,
            type: 'fullServer',
            status: 'running',
            createdAt: new Date().toISOString(),
            progress: {
                totalChannels: 0,
                completedChannels: 0,
                totalMessages: 0,
                scannedMessages: 0,
                deletedMessages: 0,
                currentChannel: null
            },
            options,
            startedBy: options.userId || null
        };

        await saveCleanupTask(guildId, taskData);
        this.tasks.set(guildId, taskData);
        
        // 暂停自动清理
        this.pauseAutoCleanup(guildId);
        
        console.log(`🚀 开始全服务器扫描任务 - Guild: ${guildId}, Task: ${taskId}`);
        return taskData;
    }

    async updateTaskProgress(guildId, taskId, progressUpdate) {
        const task = this.tasks.get(guildId);
        if (task && task.taskId === taskId) {
            Object.assign(task.progress, progressUpdate);
            task.updatedAt = new Date().toISOString();
            
            await updateCleanupTask(guildId, taskId, {
                progress: task.progress,
                updatedAt: task.updatedAt
            });
        }
    }

    async completeTask(guildId, taskId, finalStats = {}) {
        const task = this.tasks.get(guildId);
        if (task && task.taskId === taskId) {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            task.finalStats = finalStats;
            
            await updateCleanupTask(guildId, taskId, {
                status: 'completed',
                completedAt: task.completedAt,
                finalStats
            });
            
            this.tasks.delete(guildId);
            this.resumeAutoCleanup(guildId);
            
            console.log(`✅ 清理任务完成 - Guild: ${guildId}, Task: ${taskId}`);
        }
    }

    async stopTask(guildId, taskId, reason = 'manually_stopped') {
        const task = this.tasks.get(guildId);
        if (task && task.taskId === taskId) {
            task.status = 'stopped';
            task.stoppedAt = new Date().toISOString();
            task.stopReason = reason;
            
            await updateCleanupTask(guildId, taskId, {
                status: 'stopped',
                stoppedAt: task.stoppedAt,
                stopReason: reason
            });
            
            this.tasks.delete(guildId);
            this.resumeAutoCleanup(guildId);
            
            console.log(`⏹️ 清理任务已停止 - Guild: ${guildId}, Task: ${taskId}, Reason: ${reason}`);
        }
    }

    async getActiveTask(guildId) {
        // 先检查内存中的任务
        const memoryTask = this.tasks.get(guildId);
        if (memoryTask) {
            return memoryTask;
        }

        // 从数据库检查
        const dbTask = await getActiveCleanupTask(guildId);
        if (dbTask) {
            this.tasks.set(guildId, dbTask);
            return dbTask;
        }

        return null;
    }

    pauseAutoCleanup(guildId) {
        this.pausedAutoCleanup.add(guildId);
        console.log(`🚫 暂停自动清理 - Guild: ${guildId}`);
    }

    resumeAutoCleanup(guildId) {
        this.pausedAutoCleanup.delete(guildId);
        console.log(`✅ 恢复自动清理 - Guild: ${guildId}`);
    }

    isAutoCleanupPaused(guildId) {
        return this.pausedAutoCleanup.has(guildId);
    }

    getAllActiveTasks() {
        return Array.from(this.tasks.values());
    }

    getTaskStats() {
        const activeTasks = this.getAllActiveTasks();
        return {
            totalActiveTasks: activeTasks.length,
            pausedServers: this.pausedAutoCleanup.size,
            tasks: activeTasks.map(task => ({
                guildId: task.guildId,
                taskId: task.taskId,
                type: task.type,
                status: task.status,
                progress: task.progress
            }))
        };
    }
}

// 创建全局任务管理器实例
const taskManager = new TaskManager();

module.exports = { TaskManager, taskManager }; 