/**
 * 链接解析结果对象
 *
 * @typedef {Object} ParsedInfo
 * @property {string} guildId   作品所在服务器 ID
 * @property {string} channelId 作品所在频道 ID
 * @property {string} messageId 作品所在消息 ID
 * @property {'message'|'attachment'|'unknown'} linkType 链接类型
 */

/**
 * 链接预览缓存对象
 *
 * @typedef {Object} CachedPreview
 * @property {string} title                      预览标题
 * @property {string} [content]                  预览文本内容
 * @property {string|null} [imageUrl]            预览图片 URL，如无则为 null
 * @property {number} timestamp                  预览生成时间戳（毫秒）
 * @property {string} authorName                 作者名称
 * @property {string|null} [authorAvatar]        作者头像 URL，如无则为 null
 */

/**
 * 比赛投稿数据对象
 *
 * @typedef {Object} SubmissionData
 * @property {number} contestSubmissionId        比赛内的独立 ID
 * @property {string} contestChannelId           赛事频道 ID
 * @property {string} submitterId                投稿用户的 Discord ID
 * @property {string} originalUrl                用户提交的原始链接
 * @property {'message'|'attachment'|'unknown'} linkType               链接类型
 * @property {ParsedInfo} parsedInfo             解析后的链接信息
 * @property {CachedPreview} cachedPreview       链接预览缓存
 * @property {string} submissionDescription      用户填写的作品说明
 * @property {string} submittedAt                ISO 8601 格式的投稿时间
 * @property {boolean} isValid                   是否通过验证
 * @property {boolean} isExternal                是否为外部服务器投稿
 */

/**
 * 处理后的投稿数据对象
 *
 * @typedef {SubmissionData & {
 *   publishTime: number,          // 作品发布时间（Unix 秒）
 *   workUrl: string,              // 作品消息链接
 *   truncatedDescription: string, // 截断后的稿件说明（最长 300 字符）
 *   authorMention: string         // Discord 用户提及字符串
 * }} ProcessedSubmissionData
 */


/**
 * 预处理投稿数据，过滤无效投稿、按提交时间排序并计算展示用字段。
 *
 * 处理后会为每个对象追加：
 *   publishTime           {number}  作品发布时间（Unix 秒）
 *   workUrl               {string}  作品消息链接
 *   truncatedDescription  {string}  截断后的稿件说明（最长 300 字符）
 *   authorMention         {string}  Discord 用户提及字符串
 *
 * @param {SubmissionData[]} submissions 投稿数据数组
 * @returns {ProcessedSubmissionData[]} 已过滤、排序并补充字段后的投稿数据数组
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