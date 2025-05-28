/**
 * 预处理投稿数据，避免重复计算
 */
function preprocessSubmissions(submissions) {
    return submissions
        .filter(sub => sub.isValid)
        .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
        .map(sub => {
            // 预计算常用字段
            const publishTime = Math.floor(sub.cachedPreview.timestamp / 1000);
            const workUrl = `https://discord.com/channels/${sub.parsedInfo.guildId}/${sub.parsedInfo.channelId}/${sub.parsedInfo.messageId}`;
            
            // 处理稿件说明
            let truncatedDescription = sub.submissionDescription || '作者未提供稿件说明';
            if (truncatedDescription.length > 300) {
                truncatedDescription = truncatedDescription.substring(0, 300) + '.....';
            }
            
            return {
                ...sub,
                publishTime,
                workUrl,
                truncatedDescription,
                authorMention: `<@${sub.submitterId}>`
            };
        });
}

/**
 * 分页处理数据
 */
function paginateData(data, currentPage, itemsPerPage) {
    const totalItems = data.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    const validCurrentPage = Math.max(1, Math.min(currentPage, totalPages));
    
    const startIndex = (validCurrentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const pageData = data.slice(startIndex, endIndex);
    
    return {
        pageData,
        currentPage: validCurrentPage,
        totalPages,
        totalItems,
        startIndex,
        endIndex
    };
}

/**
 * 生成作品编号
 */
function generateSubmissionNumber(index, currentPage, itemsPerPage) {
    return ((currentPage - 1) * itemsPerPage) + index + 1;
}

module.exports = {
    preprocessSubmissions,
    paginateData,
    generateSubmissionNumber
}; 