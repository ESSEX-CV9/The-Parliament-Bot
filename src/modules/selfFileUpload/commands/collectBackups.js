const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { readState, writeState } = require('../services/scanStateService');
const { withRetry } = require('../utils/retryHelper');
const ProgressManager = require('../services/progressManager');

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
        const overflowContent = overflowMessages.map((item, index) => {
            // 保持原始编号
            const originalIndex = backupMessages.findIndex(bm => bm.url === item.url);
            return `${originalIndex + 1}. [${item.fileName}](${item.url}) ([图片链接](${item.attachmentUrl}))`;
        }).join('\n');

        const overflowMessage = await sendInChunks(thread, `${sectionTitle} (续)\n${overflowContent}`);
        
        if (overflowMessage && overflowMessage.url) {
            finalContent += `\n...剩余 ${overflowMessages.length} 个补档请[点击此处](${overflowMessage.url})查看。`;
        } else {
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
                .setRequired(false)),

    async execute(interaction) {
        // 进度条必须是公开消息才能被持续编辑，因此移除 ephemeral: true
        await interaction.deferReply();

        const forumChannel = interaction.options.getChannel('论坛频道');
        const resetProgress = interaction.options.getBoolean('重置进度') || false;
        const concurrency = interaction.options.getInteger('并发数') || 3;

        try {
            await interaction.editReply('⏳ 正在获取所有帖子列表（包括已归档），这可能需要一些时间，请稍候...');

            // 1. 获取所有帖子（活跃+归档）
            const activeThreads = (await forumChannel.threads.fetchActive()).threads;
            let allThreads = [...activeThreads.values()];

            let lastArchived = null;
            let moreArchived = true;
            while (moreArchived) {
                const archivedThreads = await forumChannel.threads.fetchArchived({ before: lastArchived, limit: 100 });
                if (archivedThreads.threads.size > 0) {
                    allThreads.push(...archivedThreads.threads.values());
                    lastArchived = archivedThreads.threads.lastKey();
                } else {
                    moreArchived = false;
                }
            }
            
            // 按创建顺序排序，确保断点续传的稳定性
            allThreads.sort((a, b) => a.id - b.id);

            if (allThreads.length === 0) {
                return interaction.editReply('ℹ️ 该论坛频道内没有任何帖子。');
            }

            // 2. 加载或重置状态
            let state = await readState();
            if (resetProgress) {
                state = { lastProcessedThreadId: null, processedCount: 0, failedThreads: [] };
                await writeState(state); // 重置时也写入文件
            }

            // 3. 找到断点
            let threadsToProcess = allThreads;
            if (state.lastProcessedThreadId && !resetProgress) {
                const lastIndex = allThreads.findIndex(t => t.id === state.lastProcessedThreadId);
                if (lastIndex !== -1) {
                    threadsToProcess = allThreads.slice(lastIndex + 1);
                }
            }
            
            if (threadsToProcess.length === 0) {
                 return interaction.editReply('✅ 所有帖子都已处理完毕！');
            }
            
            // 4. 初始化进度管理器
            const progressManager = new ProgressManager(interaction, threadsToProcess.length);
            await progressManager.start();

            // 5. 创建任务队列
            const tasks = threadsToProcess.map(thread => async () => {
                progressManager.addTask(thread.name);
                try {
                    await withRetry(() => processThread(thread));
                    progressManager.update(true, thread.name);
                    state.processedCount++;
                } catch (error) {
                    console.error(`处理帖子 ${thread.id} 失败 (已重试):`, error);
                    progressManager.update(false, thread.name);
                    state.failedThreads.push({ id: thread.id, name: thread.name, error: error.message });
                } finally {
                    state.lastProcessedThreadId = thread.id;
                    await writeState(state);
                }
            });

            // 6. 并发执行
            await runWithConcurrency(tasks, concurrency);

            // 7. 最终报告
            await progressManager.finish();
            let finalReport = `🎉 **扫描完成**\n\n` +
                              `- **总帖子数**: ${allThreads.length}\n` +
                              `- **本次处理**: ${tasks.length}\n` +
                              `- **成功**: ${progressManager.successCount}\n` +
                              `- **失败**: ${progressManager.failCount}`;

            if (state.failedThreads.length > 0) {
                finalReport += '\n\n**失败列表:**\n' + state.failedThreads.map(f => `- ${f.name} (${f.id})`).join('\n');
            }
            
            await interaction.followUp({ content: finalReport, ephemeral: true });

        } catch (error) {
            console.error('汇总补档命令执行失败:', error);
            await interaction.followUp({
                content: `❌ **发生严重错误**\n\n\`\`\`${error.name}: ${error.message}\`\`\``,
                ephemeral: true
            });
        }
    },
};