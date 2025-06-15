const { ElectionData, VoteData } = require('../data/electionDatabase');
const { createVotingPollsForElection, createPositionAnonymousVotingPoll } = require('./votingService');
const { calculateElectionResults } = require('./electionResultService');
const { createElectionResultEmbed } = require('../utils/messageUtils');

/**
 * 募选调度器
 */
class ElectionScheduler {
    constructor(client) {
        this.client = client;
        this.intervalId = null;
        this.isRunning = false;
    }

    /**
     * 启动调度器
     */
    start() {
        if (this.isRunning) {
            console.log('募选调度器已在运行中');
            return;
        }

        this.isRunning = true;
        console.log('✅ 募选调度器已启动');

        // 每分钟检查一次
        this.intervalId = setInterval(() => {
            this.checkElectionStates().catch(error => {
                console.error('募选状态检查时出错:', error);
            });
        }, 60000);

        // 立即执行一次检查
        this.checkElectionStates().catch(error => {
            console.error('募选状态检查时出错:', error);
        });
    }

    /**
     * 停止调度器
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('募选调度器已停止');
    }

    /**
     * 检查所有募选的状态
     */
    async checkElectionStates() {
        try {
            const elections = await ElectionData.getAll();
            const now = new Date();

            for (const election of Object.values(elections)) {
                if (!election.schedule) continue;

                const {
                    registrationStartTime,
                    registrationEndTime,
                    votingStartTime,
                    votingEndTime
                } = election.schedule;

                if (!registrationStartTime || !registrationEndTime || !votingStartTime || !votingEndTime) {
                    continue;
                }

                const regStart = new Date(registrationStartTime);
                const regEnd = new Date(registrationEndTime);
                const voteStart = new Date(votingStartTime);
                const voteEnd = new Date(votingEndTime);

                // 检查需要开始报名的募选
                if (election.status === 'setup' && now >= regStart && now <= regEnd) {
                    await this.startRegistrationPhase(election);
                }

                // 检查需要结束报名的募选
                if (election.status === 'registration' && now >= regEnd) {
                    await this.endRegistrationPhase(election);
                }

                // 检查需要开始投票的募选
                if (election.status === 'registration_ended' && now >= voteStart) {
                    await this.startVotingPhase(election);
                }

                // 检查需要结束投票的募选
                if (election.status === 'voting' && now >= voteEnd) {
                    await this.endVotingPhase(election);
                }
            }

        } catch (error) {
            console.error('检查募选状态时出错:', error);
        }
    }

    /**
     * 开始报名阶段
     */
    async startRegistrationPhase(election) {
        try {
            console.log(`开始报名阶段: ${election.name} (${election.electionId})`);

            await ElectionData.update(election.electionId, {
                status: 'registration'
            });

            // 可以在这里发送通知消息
            await this.sendPhaseNotification(election, 'registration_started');

        } catch (error) {
            console.error(`开始报名阶段时出错 (${election.electionId}):`, error);
        }
    }

    /**
     * 开始投票阶段
     */
    async startVotingPhase(election) {
        try {
            console.log(`开始投票阶段: ${election.name} (${election.electionId})`);

            // 创建投票器
            await this.createAnonymousVotingPolls(election);

            // 更新募选状态
            await ElectionData.update(election.electionId, {
                status: 'voting'
            });

            // 发送通知
            await this.sendPhaseNotification(election, 'voting_started');

        } catch (error) {
            console.error(`开始投票阶段时出错 (${election.electionId}):`, error);
        }
    }

    /**
     * 结束投票阶段
     */
    async endVotingPhase(election) {
        try {
            console.log(`结束投票阶段: ${election.name} (${election.electionId})`);

            // 禁用所有投票器按钮
            await this.disableVotingButtons(election);

            // 计算募选结果
            const results = await calculateElectionResults(election.electionId);
            
            // 更新募选状态
            await ElectionData.update(election.electionId, {
                status: 'completed',
                results: results
            });

            // 发布募选结果
            await this.publishElectionResults(election, results);

        } catch (error) {
            console.error(`结束投票阶段时出错 (${election.electionId}):`, error);
        }
    }

    /**
     * 禁用投票器按钮
     */
    async disableVotingButtons(election) {
        try {
            const votingChannelId = election.channels?.votingChannelId;
            if (!votingChannelId) {
                console.log('未设置投票频道，跳过禁用投票按钮');
                return;
            }

            const channel = this.client.channels.cache.get(votingChannelId);
            if (!channel) {
                console.error(`找不到投票频道: ${votingChannelId}`);
                return;
            }

            // 获取所有投票记录
            const votes = await VoteData.getByElection(election.electionId);
            
            for (const vote of votes) {
                if (!vote.messageId) {
                    console.log(`投票 ${vote.voteId} 没有消息ID，跳过`);
                    continue;
                }

                try {
                    const message = await channel.messages.fetch(vote.messageId);
                    if (!message) {
                        console.log(`找不到投票消息: ${vote.messageId}`);
                        continue;
                    }

                    // 创建禁用的按钮
                    const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
                    const disabledButton = new ButtonBuilder()
                        .setCustomId('election_voting_closed')
                        .setLabel('投票已结束')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🔒')
                        .setDisabled(true);

                    const row = new ActionRowBuilder().addComponents(disabledButton);

                    // 更新嵌入消息
                    const originalEmbed = message.embeds[0];
                    const updatedEmbed = EmbedBuilder.from(originalEmbed)
                        .setColor('#95a5a6') // 灰色表示已结束
                        .setTitle(`🔒 ${vote.positionName} - 投票已结束`);

                    await message.edit({
                        embeds: [updatedEmbed],
                        components: [row]
                    });

                    console.log(`投票器 ${vote.positionName} 已禁用`);

                } catch (messageError) {
                    console.error(`禁用投票器 ${vote.voteId} 时出错:`, messageError);
                }
            }

            console.log('所有投票器按钮已禁用');

        } catch (error) {
            console.error('禁用投票器按钮时出错:', error);
        }
    }

    /**
     * 发送阶段通知
     */
    async sendPhaseNotification(election, phase) {
        try {
            // 如果设置了通知频道，发送通知消息
            const channelId = election.channels?.registrationChannelId || election.channels?.votingChannelId;
            if (!channelId) return;

            const channel = this.client.channels.cache.get(channelId);
            if (!channel) return;

            let message = '';
            let emoji = '';

            switch (phase) {
                case 'registration_started':
                    message = `📝 **${election.name}** 报名已开始！\n现在可以点击报名按钮参与募选了。\n @获取投票通知`;
                    emoji = '📝';
                    break;
                case 'voting_started':
                    message = `🗳️ **${election.name}** 投票已开始！\n报名已结束，现在开始投票环节。`;
                    emoji = '🗳️';
                    break;
                default:
                    return;
            }

            await channel.send({
                content: `${emoji} ${message}`,
                allowedMentions: { parse: [] }
            });

        } catch (error) {
            console.error('发送阶段通知时出错:', error);
        }
    }

    /**
     * 发布募选结果
     */
    async publishElectionResults(election, results) {
        try {
            const channelId = election.channels?.votingChannelId || election.channels?.registrationChannelId;
            if (!channelId) return;

            const channel = this.client.channels.cache.get(channelId);
            if (!channel) return;

            const resultEmbed = createElectionResultEmbed(election, results);
            
            await channel.send({
                content: `🏆 **${election.name}** 募选结果公布！`,
                embeds: [resultEmbed]
            });

        } catch (error) {
            console.error('发布募选结果时出错:', error);
        }
    }

    /**
     * 手动触发状态检查
     */
    async forceCheck() {
        console.log('手动触发募选状态检查...');
        await this.checkElectionStates();
    }

    /**
     * 获取调度器状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            intervalId: this.intervalId !== null
        };
    }

    /**
     * 结束报名阶段
     */
    async endRegistrationPhase(election) {
        try {
            console.log(`结束报名阶段: ${election.name} (${election.electionId})`);

            // 禁用报名入口按钮
            await this.disableRegistrationEntry(election);

            // 发送候选人自我介绍到投票频道
            await this.sendCandidateIntroductions(election);

            // 更新募选状态
            await ElectionData.update(election.electionId, {
                status: 'registration_ended'
            });

            console.log(`报名阶段已结束: ${election.name}`);

        } catch (error) {
            console.error(`结束报名阶段时出错 (${election.electionId}):`, error);
        }
    }

    /**
     * 禁用报名入口按钮
     */
    async disableRegistrationEntry(election) {
        try {
            const registrationChannelId = election.channels?.registrationChannelId;
            const registrationMessageId = election.messageIds?.registrationEntryMessageId;

            if (!registrationChannelId || !registrationMessageId) {
                console.log('未找到报名入口消息，跳过禁用');
                return;
            }

            const channel = this.client.channels.cache.get(registrationChannelId);
            if (!channel) {
                console.error(`找不到报名频道: ${registrationChannelId}`);
                return;
            }

            const message = await channel.messages.fetch(registrationMessageId);
            if (!message) {
                console.error(`找不到报名入口消息: ${registrationMessageId}`);
                return;
            }

            // 创建禁用的按钮
            const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
            const disabledButton = new ButtonBuilder()
                .setCustomId('election_registration_closed')
                .setLabel('报名已结束')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔒')
                .setDisabled(true);

            const row = new ActionRowBuilder().addComponents(disabledButton);

            // 更新嵌入消息
            const originalEmbed = message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setColor('#95a5a6') // 灰色表示已结束
                .setTitle(`📝 ${election.name} - 报名已结束`);

            await message.edit({
                embeds: [updatedEmbed],
                components: [row]
            });

            console.log('报名入口已禁用');

        } catch (error) {
            console.error('禁用报名入口时出错:', error);
        }
    }

    /**
     * 发送候选人自我介绍到投票频道
     */
    async sendCandidateIntroductions(election) {
        try {
            const votingChannelId = election.channels?.votingChannelId;
            if (!votingChannelId) {
                console.error('未设置投票频道');
                return;
            }

            const channel = this.client.channels.cache.get(votingChannelId);
            if (!channel) {
                console.error(`找不到投票频道: ${votingChannelId}`);
                return;
            }

            // 获取所有报名记录，按报名时间排序
            const { RegistrationData } = require('../data/electionDatabase');
            const registrations = await RegistrationData.getByElection(election.electionId);
            
            if (registrations.length === 0) {
                await channel.send('📝 **候选人介绍**\n\n暂无候选人报名参选。');
                return;
            }

            // 按报名时间排序
            registrations.sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt));

            // 发送介绍标题
            const { EmbedBuilder } = require('discord.js');
            const introHeader = new EmbedBuilder()
                .setTitle(`📝 ${election.name} - 候选人介绍`)
                .setDescription('以下是所有候选人的自我介绍，排名不分先后：')
                .setColor('#3498db')
                .setTimestamp();

            await channel.send({ embeds: [introHeader] });

            // 逐个发送候选人介绍
            for (let i = 0; i < registrations.length; i++) {
                const registration = registrations[i];
                const firstPosition = election.positions[registration.firstChoicePosition];
                const secondPosition = registration.secondChoicePosition ? 
                    election.positions[registration.secondChoicePosition] : null;

                const embed = new EmbedBuilder()
                    .setTitle(`@${registration.userId}`)
                    .setColor('#2ecc71')
                    .addFields(
                        { name: '第一志愿', value: firstPosition?.name || '未知职位', inline: true }
                    );

                if (secondPosition) {
                    embed.addFields(
                        { name: '第二志愿', value: secondPosition.name, inline: true }
                    );
                }

                if (registration.selfIntroduction) {
                    embed.addFields(
                        { name: '自我介绍', value: registration.selfIntroduction, inline: false }
                    );
                } else {
                    embed.addFields(
                        { name: '自我介绍', value: '该候选人未填写自我介绍', inline: false }
                    );
                }

                embed.addFields(
                    { name: '报名时间', value: `<t:${Math.floor(new Date(registration.registeredAt).getTime() / 1000)}:f>`, inline: true }
                );

                await channel.send({ embeds: [embed] });

                // 延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log(`已发送 ${registrations.length} 个候选人介绍到投票频道`);

        } catch (error) {
            console.error('发送候选人介绍时出错:', error);
        }
    }

    /**
     * 创建投票器
     */
    async createAnonymousVotingPolls(election) {
        try {
            const votingChannelId = election.channels?.votingChannelId;
            if (!votingChannelId) {
                console.error('未设置投票频道');
                return;
            }

            const channel = this.client.channels.cache.get(votingChannelId);
            if (!channel) {
                console.error(`找不到投票频道: ${votingChannelId}`);
                return;
            }

            // 获取所有报名
            const { RegistrationData } = require('../data/electionDatabase');
            const registrations = await RegistrationData.getByElection(election.electionId);
            
            if (registrations.length === 0) {
                console.log('没有候选人报名，跳过投票器创建');
                return;
            }

            // 发送投票开始通知
            const { EmbedBuilder } = require('discord.js');
            const votingHeader = new EmbedBuilder()
                .setTitle(`🗳️ ${election.name} - 投票开始`)
                .setDescription('投票现在开始！请为你支持的候选人投票。')
                .setColor('#e74c3c')
                .setTimestamp();

            if (election.schedule?.votingEndTime) {
                const endTime = Math.floor(new Date(election.schedule.votingEndTime).getTime() / 1000);
                votingHeader.addFields(
                    { name: '投票截止时间', value: `<t:${endTime}:f>`, inline: false }
                );
            }

            await channel.send({ embeds: [votingHeader] });

            // 为每个职位创建投票器
            for (const [positionId, position] of Object.entries(election.positions)) {
                await createPositionAnonymousVotingPoll(channel, election, positionId, position, registrations);
                
                // 延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            console.log(`募选 ${election.name} 的投票器创建完成`);

        } catch (error) {
            console.error('创建投票器时出错:', error);
            throw error;
        }
    }
}

// 全局调度器实例
let schedulerInstance = null;

/**
 * 启动募选调度器
 * @param {Client} client Discord客户端
 */
function startElectionScheduler(client) {
    if (schedulerInstance) {
        console.log('募选调度器已存在，停止旧的调度器');
        schedulerInstance.stop();
    }

    schedulerInstance = new ElectionScheduler(client);
    schedulerInstance.start();
}

/**
 * 停止募选调度器
 */
function stopElectionScheduler() {
    if (schedulerInstance) {
        schedulerInstance.stop();
        schedulerInstance = null;
    }
}

/**
 * 获取调度器实例
 */
function getSchedulerInstance() {
    return schedulerInstance;
}

module.exports = {
    ElectionScheduler,
    startElectionScheduler,
    stopElectionScheduler,
    getSchedulerInstance
}; 