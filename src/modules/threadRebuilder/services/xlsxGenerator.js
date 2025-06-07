const path = require('path');
const fs = require('fs').promises;

/**
 * XLSX报告生成器
 * 注意：这个实现使用简单的XML格式创建Excel文件，避免引入额外的依赖
 */
class XlsxGenerator {
    constructor() {
        this.outputDir = path.resolve(process.cwd(), 'data/rebuild/reports');
    }

    /**
     * 生成重建结果报告
     */
    async generateRebuildReport(progressTracker, sessionId) {
        try {
            // 确保输出目录存在
            await fs.mkdir(this.outputDir, { recursive: true });
            
            const stats = progressTracker.getProgressStats();
            const fileDetails = progressTracker.getDetailedFileStatus();
            
            // 生成文件名
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
            const fileName = `重建报告_${sessionId}_${timestamp}.xlsx`;
            const filePath = path.join(this.outputDir, fileName);
            
            // 生成Excel内容
            const xmlContent = this.generateExcelXML(stats, fileDetails);
            
            // 写入文件
            await fs.writeFile(filePath, xmlContent, 'utf8');
            
            console.log(`报告生成完成: ${filePath}`);
            
            return {
                fileName: fileName,
                filePath: filePath,
                stats: stats
            };
            
        } catch (error) {
            console.error('生成XLSX报告失败:', error);
            throw error;
        }
    }

    /**
     * 生成Excel XML内容
     */
    generateExcelXML(stats, fileDetails) {
        const escapeXml = (text) => {
            if (text === null || text === undefined) return '';
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        };

        const formatDate = (dateString) => {
            if (!dateString) return '';
            return new Date(dateString).toLocaleString('zh-CN');
        };

        const getStatusText = (status) => {
            const statusMap = {
                'completed': '✅ 已完成',
                'failed': '❌ 失败',
                'skipped': '⏭️ 跳过',
                'pending': '⏳ 待处理',
                'processing': '🔄 处理中'
            };
            return statusMap[status] || status;
        };

        // 统计信息行
        const summaryRows = [
            ['统计项目', '数值'],
            ['会话ID', escapeXml(stats.sessionId)],
            ['开始时间', formatDate(stats.startTime)],
            ['最后更新', formatDate(stats.lastUpdateTime)],
            ['总文件数', stats.totalFiles],
            ['已完成', stats.completedFiles],
            ['失败', stats.failedFiles],
            ['跳过', stats.skippedFiles],
            ['待处理', stats.pendingFiles],
            ['处理中', stats.processingFiles],
            ['完成率', `${stats.progressPercentage}%`],
            [''], // 空行
            ['文件名', '状态', '帖子ID', '帖子名称', '消息数', '完成时间', '错误信息']
        ];

        // 文件详情行
        const detailRows = fileDetails.map(file => [
            escapeXml(file.fileName),
            getStatusText(file.status),
            escapeXml(file.threadId || ''),
            escapeXml(file.threadName || ''),
            file.messagesCount || 0,
            formatDate(file.completedAt || file.failedAt || file.skippedAt),
            escapeXml(file.error || file.skipReason || '')
        ]);

        const allRows = [...summaryRows, ...detailRows];

        // 生成XML
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:html="http://www.w3.org/TR/REC-html40">
  <Worksheet ss:Name="重建报告">
    <Table>`;

        allRows.forEach((row, rowIndex) => {
            xml += '\n      <Row>';
            row.forEach((cell, cellIndex) => {
                const cellType = typeof cell === 'number' ? 'Number' : 'String';
                xml += `<Cell><Data ss:Type="${cellType}">${escapeXml(cell)}</Data></Cell>`;
            });
            xml += '</Row>';
        });

        xml += `
    </Table>
  </Worksheet>
</Workbook>`;

        return xml;
    }

    /**
     * 获取报告文件列表
     */
    async getReportFiles() {
        try {
            const files = await fs.readdir(this.outputDir);
            return files
                .filter(file => file.endsWith('.xlsx'))
                .map(file => ({
                    name: file,
                    path: path.join(this.outputDir, file)
                }));
        } catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    /**
     * 清理旧的报告文件
     */
    async cleanOldReports(daysToKeep = 7) {
        try {
            const files = await this.getReportFiles();
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            
            for (const file of files) {
                const stats = await fs.stat(file.path);
                if (stats.mtime.getTime() < cutoffTime) {
                    await fs.unlink(file.path);
                    console.log(`清理旧报告: ${file.name}`);
                }
            }
        } catch (error) {
            console.error('清理旧报告失败:', error);
        }
    }
}

module.exports = XlsxGenerator; 