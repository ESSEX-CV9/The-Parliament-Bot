const xlsx = require('xlsx');
const { addUserToOptOutList } = require('../../../core/utils/database');
// const fetch = require('node-fetch'); // <--- 移除这一行

/**
 * 从Excel文件批量添加用户ID到屏蔽列表。
 * @param {import('discord.js').Attachment} attachment - The Excel file attachment.
 * @returns {Promise<{addedCount: number, skippedCount: number, error?: string}>} - The result of the batch operation.
 */
async function batchAddUsersFromExcel(attachment) {
    if (!attachment.name.endsWith('.xlsx') && !attachment.name.endsWith('.xls')) {
        return { addedCount: 0, skippedCount: 0, error: '❌ 请上传一个有效的Excel文件 (.xlsx 或 .xls)。' };
    }

    try {
        const response = await fetch(attachment.url); // 直接使用全局的 fetch
        if (!response.ok) throw new Error(`无法下载文件: ${response.statusText}`);
        const buffer = await response.arrayBuffer(); 
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

        const idsToAdd = data
            .map(row => row[0]) // 获取第一列的数据
            .filter(id => id && /^\d+$/.test(String(id))) // 筛选出纯数字的ID
            .map(String);

        if (idsToAdd.length === 0) {
            return { addedCount: 0, skippedCount: 0, error: '❌ 在Excel文件的第一列中没有找到有效的用户ID。' };
        }

        let addedCount = 0;
        let skippedCount = 0;

        for (const id of idsToAdd) {
            const success = await addUserToOptOutList(id);
            if (success) {
                addedCount++;
            } else {
                skippedCount++;
            }
        }

        return { addedCount, skippedCount };

    } catch (error) {
        console.error('处理Excel文件时出错:', error);
        return { addedCount: 0, skippedCount: 0, error: '❌ 处理Excel文件时发生错误，请确保文件格式正确。' };
    }
}

module.exports = { batchAddUsersFromExcel };