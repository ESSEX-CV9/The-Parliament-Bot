const { ElectionData, VoteData } = require('../data/electionDatabase');
const { createVotingPollsForElection } = require('./votingService');
const { calculateElectionResults } = require('./electionResultService');
const { createElectionResultEmbed } = require('../utils/messageUtils');

/**
 * 选举调度器
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
            console.log('选举调度器已在运行中');
            return;
        }

        this.isRunning = true;
        console.log('✅ 选举调度器已启动');

        // 每分钟检查一次
        this.intervalId = setInterval(() => {
            this.checkElectionStates().catch(error => {
                console.error('选举状态检查时出错:', error);
            });
        }, 60000);

        // 立即执行一次检查
        this.checkElectionStates().catch(error => {
            console.error('选举状态检查时出错:', error);
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
        console.log('选举调度器已停止');
    }

    /**
     * 检查所有选举的状态
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

                // 检查需要开始报名的选举
                if (election.status === 'setup' && now >= regStart && now <= regEnd) {
                    await this.startRegistrationPhase(election);
                }

                // 检查需要结束报名并开始投票的选举
                if (election.status === 'registration' && now >= voteStart) {
                    await this.startVotingPhase(election);
                }

                // 检查需要结束投票的选举
                if (election.status === 'voting' && now >= voteEnd) {
                    await this.endVotingPhase(election);
                }
            }

        } catch (error) {
            console.error('检查选举状态时出错:', error);
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

            // 生成投票器
            await createVotingPollsForElection(this.client, election);

            // 更新选举状态
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

            // 计算选举结果
            const results = await calculateElectionResults(election.electionId);
            
            // 更新选举状态
            await ElectionData.update(election.electionId, {
                status: 'completed',
                results: results
            });

            // 发布选举结果
            await this.publishElectionResults(election, results);

        } catch (error) {
            console.error(`结束投票阶段时出错 (${election.electionId}):`, error);
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
                    message = `📝 **${election.name}** 报名已开始！\n现在可以点击报名按钮参与选举了。`;
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
     * 发布选举结果
     */
    async publishElectionResults(election, results) {
        try {
            const channelId = election.channels?.votingChannelId || election.channels?.registrationChannelId;
            if (!channelId) return;

            const channel = this.client.channels.cache.get(channelId);
            if (!channel) return;

            const resultEmbed = createElectionResultEmbed(election, results);
            
            await channel.send({
                content: `🏆 **${election.name}** 选举结果公布！`,
                embeds: [resultEmbed]
            });

        } catch (error) {
            console.error('发布选举结果时出错:', error);
        }
    }

    /**
     * 手动触发状态检查
     */
    async forceCheck() {
        console.log('手动触发选举状态检查...');
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
}

// 全局调度器实例
let schedulerInstance = null;

/**
 * 启动选举调度器
 * @param {Client} client Discord客户端
 */
function startElectionScheduler(client) {
    if (schedulerInstance) {
        console.log('选举调度器已存在，停止旧的调度器');
        schedulerInstance.stop();
    }

    schedulerInstance = new ElectionScheduler(client);
    schedulerInstance.start();
}

/**
 * 停止选举调度器
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