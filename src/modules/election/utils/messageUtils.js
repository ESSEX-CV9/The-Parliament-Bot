const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { formatChineseTime } = require('./timeUtils');
const { STATUS_CONFIG, CANDIDATE_STATUS } = require('./tieBreakingUtils');

/**
 * 添加字段并处理长度限制
 * @param {EmbedBuilder} embed - 嵌入消息构建器
 * @param {string} fieldName - 字段名称
 * @param {string} fieldValue - 字段值
 */
function addFieldWithLengthLimit(embed, fieldName, fieldValue) {
    const FIELD_VALUE_LIMIT = 1024;
    
    // 如果内容不超过限制，直接添加
    if (fieldValue.length <= FIELD_VALUE_LIMIT) {
        embed.addFields({ name: fieldName, value: fieldValue, inline: false });
        return;
    }
    
    // 内容过长，需要拆分
    // 首先分离候选人信息和统计信息
    const parts = fieldValue.split('\n\n📊 **投票统计**');
    const candidatesText = parts[0];
    const statisticsText = parts[1] ? `📊 **投票统计**${parts[1]}` : '';
    
    // 拆分候选人信息
    const candidateEntries = candidatesText.split('\n\n');
    const chunks = [];
    let currentChunk = '';
    
    for (const entry of candidateEntries) {
        const testChunk = currentChunk ? `${currentChunk}\n\n${entry}` : entry;
        
        if (testChunk.length <= FIELD_VALUE_LIMIT - 50) { // 留50字符余量
            currentChunk = testChunk;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk);
            }
            currentChunk = entry;
        }
    }
    
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    
    // 添加拆分后的字段
    chunks.forEach((chunk, index) => {
        const chunkFieldName = chunks.length > 1 ? `${fieldName} (第${index + 1}部分)` : fieldName;
        embed.addFields({ name: chunkFieldName, value: chunk, inline: false });
    });
    
    // 单独添加统计信息
    if (statisticsText) {
        embed.addFields({ name: `${fieldName} - 统计信息`, value: statisticsText, inline: false });
    }
}

/**
 * 创建募选状态嵌入消息
 * @param {object} election - 募选数据
 * @returns {EmbedBuilder} 嵌入消息
 */
function createElectionStatusEmbed(election) {
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${election.name}`)
        .setColor('#3498db');
    
    // 状态显示
    const statusMap = {
        'setup': '⚙️ 设置中',
        'registration': '📝 报名中',
        'voting': '🗳️ 投票中',
        'completed': '✅ 已完成'
    };
    
    embed.addFields(
        { name: '募选状态', value: statusMap[election.status] || '未知', inline: true }
    );
    
    // 职位信息
    if (election.positions) {
        const positionList = Object.values(election.positions)
            .map(pos => `• ${pos.name} (${pos.maxWinners}人)`)
            .join('\n');
        embed.addFields(
            { name: '竞选职位', value: positionList || '暂未设置', inline: false }
        );
    }
    
    // 时间安排
    if (election.schedule) {
        const { registrationStartTime, registrationEndTime, votingStartTime, votingEndTime } = election.schedule;
        
        let timeInfo = '';
        if (registrationStartTime && registrationEndTime) {
            timeInfo += `📝 报名时间: ${formatChineseTime(new Date(registrationStartTime))} - ${formatChineseTime(new Date(registrationEndTime))}\n`;
        }
        if (votingStartTime && votingEndTime) {
            timeInfo += `🗳️ 投票时间: ${formatChineseTime(new Date(votingStartTime))} - ${formatChineseTime(new Date(votingEndTime))}`;
        }
        
        if (timeInfo) {
            embed.addFields(
                { name: '时间安排', value: timeInfo, inline: false }
            );
        }
    }
    
    embed.setTimestamp()
        .setFooter({ text: '募选系统' });
    
    return embed;
}

/**
 * 创建报名入口嵌入消息
 * @param {object} election - 选举数据
 * @returns {object} 消息组件
 */
function createRegistrationEntryMessage(election) {
    const now = new Date();
    const regStartTime = election.schedule ? new Date(election.schedule.registrationStartTime) : null;
    const regEndTime = election.schedule ? new Date(election.schedule.registrationEndTime) : null;
    
    // 确定当前状态
    let isBeforeStart = regStartTime && now < regStartTime;
    let isAfterEnd = regEndTime && now > regEndTime;
    let isActive = regStartTime && regEndTime && now >= regStartTime && now <= regEndTime;
    
    const embed = new EmbedBuilder()
        .setTitle(`📝 ${election.name} - 报名入口`)
        .setColor('#2ecc71');
    
    // 根据状态设置描述和颜色
    if (isBeforeStart) {
        embed.setDescription('报名尚未开始，请耐心等待')
             .setColor('#ffa500'); // 橙色表示等待中
    } else if (isAfterEnd) {
        embed.setDescription('报名时间已结束')
             .setColor('#95a5a6'); // 灰色表示已结束
    } else if (isActive) {
        embed.setDescription('点击下方按钮开始报名参选')
             .setColor('#2ecc71'); // 绿色表示活跃
    } else {
        embed.setDescription('点击下方按钮开始报名参选');
    }
    
    // 显示职位列表
    if (election.positions) {
        const positionList = Object.values(election.positions)
            .map(pos => `• **${pos.name}** (招募${pos.maxWinners}人)${pos.description ? ` - ${pos.description}` : ''}`)
            .join('\n');
        
        embed.addFields(
            { name: '可竞选职位', value: positionList, inline: false }
        );
    }
    
    // 报名时间
    if (election.schedule && election.schedule.registrationStartTime && election.schedule.registrationEndTime) {
        const startTime = formatChineseTime(new Date(election.schedule.registrationStartTime));
        const endTime = formatChineseTime(new Date(election.schedule.registrationEndTime));
        
        embed.addFields(
            { name: '报名时间', value: `${startTime} - ${endTime}`, inline: false }
        );
    }
    
    embed.addFields(
        { name: '报名须知', value: '• 每人只能报名一次\n• 可设置第一志愿和第二志愿\n• 可填写自我介绍(可选)\n• 报名后可修改或撤回', inline: false }
    );
    
    // 根据状态创建不同的按钮
    let button;
    if (isBeforeStart) {
        button = new ButtonBuilder()
            .setCustomId('election_registration_not_started')
            .setLabel('报名未开始')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⏰')
            .setDisabled(true);
    } else if (isAfterEnd) {
        button = new ButtonBuilder()
            .setCustomId('election_registration_closed')
            .setLabel('报名已结束')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔒')
            .setDisabled(true);
    } else {
        button = new ButtonBuilder()
            .setCustomId(`election_register_${election.electionId}`)
            .setLabel('开始报名')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝');
    }
    
    const row = new ActionRowBuilder().addComponents(button);
    
    return { embeds: [embed], components: [row] };
}

/**
 * 创建投票入口嵌入消息
 * @param {object} election - 募选数据
 * @param {Array} votes - 投票数据数组
 * @returns {object} 消息组件
 */
function createVotingEntryMessage(election, votes) {
    const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${election.name} - 投票中`)
        .setDescription('为你支持的候选人投票')
        .setColor('#e74c3c');
    
    // 投票时间
    if (election.schedule && election.schedule.votingStartTime && election.schedule.votingEndTime) {
        const startTime = formatChineseTime(new Date(election.schedule.votingStartTime));
        const endTime = formatChineseTime(new Date(election.schedule.votingEndTime));
        
        embed.addFields(
            { name: '投票时间', value: `${startTime} - ${endTime}`, inline: false }
        );
    }
    
    // 投票说明
    embed.addFields(
        { name: '投票说明', value: '• 每个职位可选择对应的候选人数量\n• 每人每个职位只能投票一次\n• 投票后不可修改\n• 按票数高低确定当选者', inline: false }
    );
    
    return { embeds: [embed] };
}

/**
 * 创建候选人列表嵌入消息
 * @param {string} positionName - 职位名称
 * @param {Array} candidates - 候选人列表
 * @param {number} maxSelections - 最大选择数
 * @returns {EmbedBuilder} 嵌入消息
 */
function createCandidateListEmbed(positionName, candidates, maxSelections) {
    const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${positionName} - 候选人列表`)
        .setDescription(`请选择你支持的候选人 (最多选择 ${maxSelections} 人)`)
        .setColor('#9b59b6');
    
    if (candidates.length === 0) {
        embed.addFields(
            { name: '暂无候选人', value: '还没有人报名这个职位', inline: false }
        );
    } else {
        const candidateList = candidates.map((candidate) => {
            let info = `<@${candidate.userId}>`;
            if (candidate.choiceType === 'second') {
                info += ' (第二志愿)';
            }
            if (candidate.selfIntroduction) {
                info += `\n${candidate.selfIntroduction}`;
            }
            return info;
        }).join('\n\n');
        
        embed.addFields(
            { name: '候选人信息', value: candidateList, inline: false }
        );
    }
    
    return embed;
}

/**
 * 创建报名成功嵌入消息
 * @param {object} registration - 报名数据
 * @param {object} election - 募选数据
 * @returns {EmbedBuilder} 嵌入消息
 */
function createRegistrationSuccessEmbed(registration, election) {
    const embed = new EmbedBuilder()
        .setTitle('✅ 报名成功')
        .setDescription('你已成功报名参选')
        .setColor('#2ecc71');
    
    const firstChoicePosition = election.positions[registration.firstChoicePosition];
    const secondChoicePosition = registration.secondChoicePosition ? 
        election.positions[registration.secondChoicePosition] : null;
    
    embed.addFields(
        { name: '第一志愿', value: firstChoicePosition?.name || '未知职位', inline: true }
    );
    
    if (secondChoicePosition) {
        embed.addFields(
            { name: '第二志愿', value: secondChoicePosition.name, inline: true }
        );
    }
    
    if (registration.selfIntroduction) {
        embed.addFields(
            { name: '自我介绍', value: registration.selfIntroduction, inline: false }
        );
    }
    
    embed.addFields(
        { name: '报名时间', value: formatChineseTime(new Date(registration.registeredAt)), inline: false }
    );
    
    return embed;
}

/**
 * 创建募选结果嵌入消息
 * @param {object} election - 募选数据
 * @param {object} results - 募选结果
 * @returns {EmbedBuilder} 嵌入消息
 */
function createElectionResultEmbed(election, results) {
    const embed = new EmbedBuilder()
        .setTitle(`🏆 ${election.name} - 募选结果`)
        .setDescription('各职位候选人得票情况如下：')
        .setColor('#f39c12');
    
    for (const [positionId, result] of Object.entries(results)) {
        const position = election.positions[positionId];
        if (!position) continue;
        
        let fieldValue;
        let fieldName = `${position.name} (募选${position.maxWinners}人)`;
        
        if (result.isVoid) {
            // 职位投票作废
            fieldValue = `❌ **${result.voidReason}**`;
        } else if (result.candidates.length === 0) {
            // 没有候选人
            fieldValue = '❌ **无人报名参选**';
        } else {
            // 显示所有候选人的得票情况，支持新的状态系统
            const candidateResults = result.candidates.map(candidate => {
                let status, statusIcon;
                
                // 检查是否有新的状态信息
                if (candidate.statusInfo) {
                    const statusConfig = STATUS_CONFIG[candidate.statusInfo.status];
                    statusIcon = statusConfig.icon;
                    status = `**${statusConfig.label}**`;
                    
                    // 添加状态说明
                    if (candidate.statusInfo.notes) {
                        status += ` (${candidate.statusInfo.notes})`;
                    }
                } else {
                    // 兼容旧系统
                    statusIcon = candidate.isWinner ? '✅' : '❌';
                    status = candidate.isWinner ? '**当选**' : '未当选';
                }
                
                const choiceLabel = candidate.choiceType === 'second' ? ' (第二志愿)' : '';
                
                // 两行显示格式
                const userMention = `<@${candidate.userId}>`;
                const userInfo = `${candidate.displayName || '未知用户'} ${candidate.votes}票 ${statusIcon} ${status}${choiceLabel}`;
                
                return `${userMention}\n${userInfo}`;
            });
            
            fieldValue = candidateResults.join('\n\n');
            
            // 添加投票统计
            if (result.totalVoters > 0) {
                fieldValue += `\n\n📊 **投票统计**`;
                fieldValue += `\n• 参与投票人数：${result.totalVoters}人`;
                fieldValue += `\n• 总票数：${result.totalVotes}票`;
                
                // 如果总票数大于投票人数，说明有多选
                if (result.totalVotes > result.totalVoters) {
                    const avgVotes = (result.totalVotes / result.totalVoters).toFixed(1);
                    fieldValue += `\n• 平均每人投票：${avgVotes}票`;
                }
            }
        }
        
        // 处理字段长度限制（Discord限制为1024字符）
        addFieldWithLengthLimit(embed, fieldName, fieldValue);
    }
    
        // 添加并列分析摘要（如果存在）
    if (results._tieAnalysis && results._tieAnalysis.hasAnyTies) {
        const tieGroups = [];
        for (const [positionId, result] of Object.entries(results)) {
            if (result.tieAnalysis?.hasTies) {
                const position = election.positions[positionId];
                tieGroups.push(`${position.name}: ${result.tieAnalysis.tieGroups.length}组并列`);
            }
        }
        
        if (tieGroups.length > 0) {
            embed.addFields(
                { name: '⚠️ 并列情况', value: `检测到并列情况，需要进一步处理：\n${tieGroups.join('\n')}`, inline: false }
            );
        }
    }
    
    embed.setTimestamp()
        .setFooter({ text: '募选结果统计' });
    
    return embed;
}

/**
 * 创建并列分析详细报告嵌入消息
 * @param {object} election - 募选数据
 * @param {object} results - 募选结果（包含并列分析）
 * @returns {EmbedBuilder} 嵌入消息
 */
function createTieAnalysisEmbed(election, results) {
    const embed = new EmbedBuilder()
        .setTitle(`⚠️ ${election.name} - 并列分析报告`)
        .setDescription('以下是检测到的并列情况和可能的影响：')
        .setColor('#f39c12');

    if (!results._tieAnalysis?.hasAnyTies) {
        embed.setDescription('🎉 未检测到任何并列情况，选举结果确定！');
        embed.setColor('#2ecc71');
        return embed;
    }

    // 显示每个职位的并列情况
    for (const [positionId, result] of Object.entries(results)) {
        if (result.tieAnalysis?.hasTies) {
            const position = election.positions[positionId];
            
            result.tieAnalysis.tieGroups.forEach((group, index) => {
                const groupTitle = `${position.name} - 并列组 ${index + 1}`;
                const tiedCandidates = group.candidates.map(c => {
                    const userMention = `<@${c.userId}>`;
                    const userInfo = `${c.displayName || '未知用户'} (${c.votes}票)`;
                    return `${userMention}\n${userInfo}`;
                }).join('\n\n');
                
                let description = `**并列候选人：**\n${tiedCandidates}\n\n`;
                description += `**排名：** 第${group.startRank}名\n`;
                description += `**票数：** ${group.votes}票\n`;
                description += `**可当选名额：** ${group.slotsInGroup}人\n`;
                description += `**志愿类型：** ${group.choiceType === 'first' ? '第一志愿' : '第二志愿'}`;

                embed.addFields(
                    { name: groupTitle, value: description, inline: false }
                );
            });
        }
    }

    // 显示连锁影响摘要
    const chainEffects = results._tieAnalysis.chainEffects;
    if (Object.keys(chainEffects.scenarios).length > 0) {
        let impactSummary = '并列处理的不同方案会对其他职位产生影响：\n\n';
        
        const processedTieGroups = new Set();
        for (const scenario of Object.values(chainEffects.scenarios)) {
            if (!processedTieGroups.has(scenario.tieGroupId)) {
                const affectedPositions = scenario.impacts.affectedPositions;
                if (affectedPositions.length > 0) {
                    impactSummary += `**${scenario.tieGroupId}的影响：**\n`;
                    affectedPositions.forEach(impact => {
                        const pos = election.positions[impact.positionId];
                        impactSummary += `• ${pos?.name || '未知职位'}: ${impact.effect}\n`;
                    });
                    impactSummary += '\n';
                }
                processedTieGroups.add(scenario.tieGroupId);
            }
        }

        if (impactSummary.length > 50) {
            embed.addFields(
                { name: '🔗 连锁影响分析', value: impactSummary, inline: false }
            );
        }
    }

    // 添加处理建议
    embed.addFields(
        { 
            name: '📋 处理建议', 
            value: '• 管理员需要决定并列候选人的处理方式\n• 可考虑扩招、重新投票或其他公平方式\n• 处理前请考虑对其他职位的连锁影响', 
            inline: false 
        }
    );

    embed.setTimestamp()
        .setFooter({ text: '并列分析系统' });

    return embed;
}

/**
 * 创建错误嵌入消息
 * @param {string} title - 错误标题
 * @param {string|Array} errors - 错误信息  
 * @returns {EmbedBuilder} 错误消息嵌入
 */
function createErrorEmbed(title, errors) {
    const embed = new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setColor('#e74c3c');
    
    if (Array.isArray(errors)) {
        embed.setDescription(errors.map(error => `• ${error}`).join('\n'));
    } else {
        embed.setDescription(errors);
    }
    
    return embed;
}

/**
 * 创建成功嵌入消息
 * @param {string} title - 成功标题
 * @param {string} description - 描述
 * @returns {EmbedBuilder} 成功消息嵌入
 */
function createSuccessEmbed(title, description) {
    const embed = new EmbedBuilder()
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setColor('#2ecc71')
        .setTimestamp();
    
    return embed;
}

module.exports = {
    createElectionStatusEmbed,
    createRegistrationEntryMessage,
    createVotingEntryMessage,
    createCandidateListEmbed,
    createRegistrationSuccessEmbed,
    createElectionResultEmbed,
    createTieAnalysisEmbed,
    createErrorEmbed,
    createSuccessEmbed
}; 