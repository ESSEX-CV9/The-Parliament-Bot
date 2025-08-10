const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { readState, writeState } = require('../services/scanStateService');
const { withRetry } = require('../utils/retryHelper');
const PublicProgressManager = require('../../../core/utils/publicProgressManager');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { sleep } = require('../utils/sleep');

// --- 轻量级并发控制器 ---
async function runWithConcurrency(tasks, concurrency) {
    const results = [];
    const queue = [...tasks];
    const active = [];

    while (queue.length > 0 || active.length > 0) {
        while (active.length < concurrency && queue.length > 0) {
            const task = queue.shift();
            const promise = task().then(result => {
                results.push(result);
                active.splice(active.indexOf(promise), 1);
            });
            active.push(promise);
        }
        await Promise.race(active);
    }
    return results;
}


// --- 消息分块发送辅助函数 ---
async function sendInChunks(thread, text, chunkSize = 1980) {
    if (text.length <= chunkSize) {
        try {
            return await thread.send({ content: text });
        } catch (error) {
            console.error(`发送消息失败 (thread: ${thread.id}):`, error);
            return null;
        }
    }

    const lines = text.split('\n');
    const messages = [];
    let currentChunk = '';

    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > chunkSize) {
            try {
                const sentMessage = await thread.send({ content: currentChunk });
                messages.push(sentMessage);
            } catch (error) {
                console.error(`发送分块消息失败 (thread: ${thread.id}):`, error);
            }
            currentChunk = '';
        }
        currentChunk += line + '\n';
    }

    if (currentChunk) {
        try {
            const sentMessage = await thread.send({ content: currentChunk });
            messages.push(sentMessage);
        } catch (error) {
            console.error(`发送最后的分块消息失败 (thread: ${thread.id}):`, error);
        }
    }
    
    return messages.length > 0 ? messages[0] : null; // 返回第一条消息用于创建链接
}


// --- 主处理函数 ---
async function processThread(thread) {
    // ... (这部分逻辑不变)
    console.log(`[开始处理帖子] ${thread.name} (${thread.id})`);
    
    const backupMessages = await scanMessagesInThread(thread);
    if (backupMessages.length === 0) {
        console.log(`[处理完成] 帖子 ${thread.id} 中无补档内容。`);
        return { success: true, found: 0 };
    }

    await updateStarterMessage(thread, backupMessages);
    console.log(`[处理完成] 帖子 ${thread.id} 首楼已更新，包含 ${backupMessages.length} 个条目。`);
    
    return { success: true, found: backupMessages.length };
}

// --- 消息扫描模块 ---
async function scanMessagesInThread(thread) {
    // ... (这部分逻辑不变)
    let lastId;
    const backupMessages = [];
    
    while (true) {
        const fetchedMessages = await thread.messages.fetch({ limit: 100, before: lastId });
        if (fetchedMessages.size === 0) break;

        for (const message of fetchedMessages.values()) {
            const isBot = message.author.bot;
            const embed = message.embeds && message.embeds[0];
            if (!isBot || !embed) continue;

            const hasCorrectFooter = embed.footer && embed.footer.text && embed.footer.text.startsWith('补卡系统 •');
            const isFileBackup = embed.title === '📸 角色卡补充';

            if (hasCorrectFooter && isFileBackup) {
                const attachment = message.attachments.first();
                if (attachment && attachment.url) {
                    const fileInfoField = embed.fields.find(f => f.name === '📁 文件信息');
                    let fileName = '未知文件';
                    if (fileInfoField && fileInfoField.value) {
                        const match = fileInfoField.value.match(/\*\*文件名\*\*: (.+)/);
                        if (match) fileName = match[1];
                    }
                    backupMessages.push({
                        url: message.url,
                        attachmentUrl: attachment.url,
                        fileName: fileName,
                        timestamp: message.createdTimestamp,
                    });
                }
            }
        }
        lastId = fetchedMessages.lastKey();
    }
    
    backupMessages.sort((a, b) => a.timestamp - b.timestamp);
    return backupMessages;
}

// --- 首楼更新模块 ---
async function updateStarterMessage(thread, backupMessages) {
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
    if (!starterMessage) {
        console.warn(`无法获取帖子 ${thread.id} 的首楼消息。`);
        return;
    }

    let baseContent = starterMessage.content || '';
    const sectionTitle = '补卡系统补档:';
    const sectionRegex = new RegExp(`\\n*${sectionTitle}[\\s\\S]*`, 'm');
    
    // 移除旧的补档部分
    baseContent = baseContent.replace(sectionRegex, '').trim();

    const entriesForStarter = [];
    let overflowMessages = [];
    const maxLength = 1990; // 为链接和标题留出足够空间
    let currentLength = baseContent.length + sectionTitle.length + 4; // 基础长度

    for (let i = 0; i < backupMessages.length; i++) {
        const item = backupMessages[i];
        const entryLine = `${i + 1}. [${item.fileName}](${item.url}) ([图片链接](${item.attachmentUrl}))`;
        
        // 模拟添加链接后的长度
        const linkPlaceholder = `\n...剩余 ${backupMessages.length - i} 个补档请点击查看`;
        
        if (currentLength + entryLine.length + linkPlaceholder.length > maxLength) {
            // 如果添加当前行和链接就会超长，则将此行及之后的所有内容都视为溢出
            overflowMessages = backupMessages.slice(i);
            break;
        }
        
        entriesForStarter.push(entryLine);
        currentLength += entryLine.length + 1; // +1 for newline
    }

    let finalContent = `${baseContent}\n\n${sectionTitle}\n${entriesForStarter.join('\n')}`;

    if (overflowMessages.length > 0) {
        let overflowContent = `${sectionTitle} (续)\n` + overflowMessages.map((item, index) => {
            const originalIndex = backupMessages.findIndex(bm => bm.url === item.url);
            return `${originalIndex + 1}. [${item.fileName}](${item.url}) ([图片链接](${item.attachmentUrl}))`;
        }).join('\n');

        // 为防止溢出消息自身也超长，进行截断
        if (overflowContent.length > 1950) {
            overflowContent = overflowContent.substring(0, 1950) + '\n... (部分溢出内容过长被截断)';
        }

        try {
            // 直接发送单个回复，不再使用分块函数
            const overflowMessage = await thread.send({ content: overflowContent });
            if (overflowMessage && overflowMessage.url) {
                finalContent += `\n...剩余 ${overflowMessages.length} 个补档请[点击此处](${overflowMessage.url})查看。`;
            } else {
                 throw new Error('发送溢出消息后未能获取有效URL。');
            }
        } catch (e) {
            console.error(`发送溢出消息失败 (thread: ${thread.id}):`, e);
            finalContent += `\n...(${overflowMessages.length} 个补档因错误无法生成链接)。`;
        }
    }

    // 最后保险截断，防止计算错误
    if (finalContent.length > 2000) {
        finalContent = finalContent.substring(0, 1997) + '...';
    }

    await starterMessage.edit({ content: finalContent });
}


module.exports = {
    data: new SlashCommandBuilder()
        .setName('汇总全频道补档')
        .setDescription('扫描整个论坛频道，将所有帖子的补卡系统补档汇总到各自的首楼。')
        .addChannelOption(option =>
            option.setName('论坛频道')
                .setDescription('要扫描的论坛频道')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildForum))
        .addIntegerOption(option =>
            option.setName('并发数')
                .setDescription('同时处理的帖子数量（1-10）。默认为3。')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10))
        .addBooleanOption(option =>
            option.setName('重置进度')
                .setDescription('是否从头开始扫描，忽略上次的进度。默认为否。')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('归档前延迟')
                .setDescription('每批处理后归档前的等待毫秒数(0-5000)。默认为200ms。')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(5000)),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                ephemeral: true,
            });
        }

        const forumChannel = interaction.options.getChannel('论坛频道');
        const resetProgress = interaction.options.getBoolean('重置进度') || false;
        const concurrency = interaction.options.getInteger('并发数') || 3;
        const archiveDelay = interaction.options.getInteger('归档前延迟') ?? 200;

        const progressManager = new PublicProgressManager(interaction);

        try {
            await progressManager.initialize('⏳ 正在初始化扫描...');

            // 1. 加载或重置状态
            let state = await readState();
            if (resetProgress) {
                state = { lastProcessedThreadId: null, processedCount: 0, failedThreads: [] };
                await writeState(state);
                await progressManager.update('🔄 进度已重置，将从头开始扫描。');
            }

            // 2. 获取所有帖子
            await progressManager.update('⏳ 正在获取所有帖子，这可能需要一些时间...');
            const activeThreads = await fetchAllThreads(forumChannel, 'fetchActive');
            const archivedThreads = await fetchAllThreads(forumChannel, 'fetchArchived');

            const allThreads = new Map();
            activeThreads.forEach(t => allThreads.set(t.id, t));
            archivedThreads.forEach(t => allThreads.set(t.id, t));

            const sortedThreads = [...allThreads.values()].sort((a, b) => a.id - b.id);
            const totalFetched = sortedThreads.length;

            if (totalFetched === 0) {
                return progressManager.finish('ℹ️ 该论坛频道内没有任何帖子。');
            }

            // 筛选出需要处理的帖子
            const pendingThreads = sortedThreads.filter(thread => !state.lastProcessedThreadId || thread.id > state.lastProcessedThreadId);
            
            if (pendingThreads.length === 0 && !resetProgress) {
                return progressManager.finish('✅ 所有帖子都已是最新状态，无需处理。');
            }
            
            await progressManager.update(`🔍 共发现 ${totalFetched} 个帖子，其中 ${pendingThreads.length} 个待处理。\n⚡ 并发数: ${concurrency}`);

            // 3. 创建并执行任务
            let successCount = 0;
            let failCount = 0;

            const processAndTrack = async (thread) => {
                try {
                    const result = await withRetry(() => processThread(thread));
                    if (result && result.found > 0) {
                        successCount++;
                        return thread; // 返回帖子对象用于归档
                    }
                    return null; // 没有找到内容，不归档
                } catch (error) {
                    console.error(`处理帖子 ${thread.id} 失败 (已重试):`, error);
                    failCount++;
                    state.failedThreads.push({ id: thread.id, name: thread.name, error: error.message });
                    return null; // 失败，不归档
                } finally {
                    state.lastProcessedThreadId = thread.id > (state.lastProcessedThreadId || 0) ? thread.id : state.lastProcessedThreadId;
                    await writeState(state);
                }
            };

            const allTasks = pendingThreads.map(thread => () => processAndTrack(thread));
            
            for (let i = 0; i < allTasks.length; i += concurrency) {
                const batchTasks = allTasks.slice(i, i + concurrency);
                if (batchTasks.length === 0) continue;

                const processedThreadsInBatch = await runWithConcurrency(batchTasks, concurrency);
                
                const processedCount = i + batchTasks.length;
                const progressPercent = Math.round((processedCount / pendingThreads.length) * 100);
                await progressManager.update(
                    `[${'█'.repeat(progressPercent / 5)}${'░'.repeat(20 - progressPercent / 5)}] ${progressPercent}%\n` +
                    `处理中: ${processedCount}/${pendingThreads.length} | 成功: ${successCount} | 失败: ${failCount}`
                );

                const successfullyProcessed = processedThreadsInBatch.filter(t => t !== null);
                if (successfullyProcessed.length > 0 && archiveDelay >= 0) {
                    if (archiveDelay > 0) await sleep(archiveDelay);
                    for (const thread of successfullyProcessed) {
                        try {
                            await thread.setArchived(true, '汇总补档后自动归档');
                        } catch (error) {
                            console.warn(`[强制归档] 操作帖子 ${thread.id} 失败:`, error.message);
                        }
                    }
                }
            }

            // 4. 最终报告
            let finalReport = `**扫描统计**\n` +
                              `- **共扫描帖子**: ${totalFetched}\n` +
                              `- **本次处理**: ${pendingThreads.length}\n` +
                              `- **成功**: ${successCount}\n` +
                              `- **失败**: ${failCount}`;

            const uniqueFailedThreads = [...new Map(state.failedThreads.map(item => [item.id, item])).values()];
            if (uniqueFailedThreads.length > 0) {
                finalReport += '\n\n**失败列表:**\n' + uniqueFailedThreads.map(f => `- ${f.name} (${f.id})`).join('\n');
            }

            await progressManager.finish(finalReport);

        } catch (error) {
            console.error('汇总补档命令执行失败:', error);
            const errorMessage = `❌ **发生严重错误**\n\n\`\`\`${error.name}: ${error.message}\`\`\``;
            await progressManager.sendError(errorMessage);
        }
    },
};

// --- 辅助函数：可靠地获取所有帖子 ---
async function fetchAllThreads(channel, fetchType) {
    const allThreads = new Map();
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
        try {
            const options = { limit: 100, cache: false };
            if (lastId) {
                // fetchActive 使用 after, fetchArchived 使用 before
                if (fetchType === 'fetchActive') {
                    options.after = lastId;
                } else {
                    options.before = lastId;
                }
            }
            
            const fetched = await channel.threads[fetchType](options);
            
            if (fetched.threads.size > 0) {
                fetched.threads.forEach(thread => {
                    allThreads.set(thread.id, thread);
                });
                // 获取最后一个帖子的ID用于下一次分页
                lastId = fetched.threads.lastKey();
            }
            
            hasMore = fetched.hasMore;

        } catch (error) {
            console.error(`Error during ${fetchType}:`, error);
            // 如果出错，停止继续获取，但返回已获取的部分
            hasMore = false;
        }
    }
    return [...allThreads.values()];
}