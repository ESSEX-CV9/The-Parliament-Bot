const fs = require('fs').promises;
const path = require('path');
const config = require('../config/backupConfig');

class FileLocator {
    constructor() {
        this.picDir = path.resolve(process.cwd(), config.paths.picDir);
        this.characterDir = path.resolve(process.cwd(), config.paths.characterDir);
        this.brainCardDir = path.resolve(process.cwd(), config.paths.brainCardDir);
        
        // 缓存目录文件列表以提高性能
        this.fileCache = new Map();
        this.cacheInitialized = false;
    }

    /**
     * 初始化文件缓存
     */
    async initializeCache() {
        if (this.cacheInitialized) {
            return;
        }

        try {
            console.log('正在初始化文件缓存...');
            
            // 缓存pic目录
            await this.cacheDirectory(this.picDir, 'pic');
            
            // 缓存characters目录
            await this.cacheDirectory(this.characterDir, 'characters');
            
            // 缓存类脑角色卡目录及其子目录
            await this.cacheDirectoryRecursive(this.brainCardDir, 'brainCard');
            
            this.cacheInitialized = true;
            console.log(`文件缓存初始化完成，共缓存 ${this.fileCache.size} 个文件`);
            
        } catch (error) {
            console.error('初始化文件缓存失败:', error);
            // 即使缓存失败也继续执行，使用实时搜索
        }
    }

    /**
     * 缓存单个目录
     */
    async cacheDirectory(dirPath, prefix) {
        try {
            if (!(await this.directoryExists(dirPath))) {
                console.warn(`目录不存在: ${dirPath}`);
                return;
            }

            const files = await fs.readdir(dirPath);
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stat = await fs.stat(filePath);
                
                if (stat.isFile()) {
                    const key = `${prefix}:${file.toLowerCase()}`;
                    this.fileCache.set(key, filePath);
                }
            }
            
            console.log(`缓存目录 ${dirPath}: ${files.filter(f => f.includes('.')).length} 个文件`);
            
        } catch (error) {
            console.error(`缓存目录失败 ${dirPath}:`, error);
        }
    }

    /**
     * 递归缓存目录及其子目录
     */
    async cacheDirectoryRecursive(dirPath, prefix) {
        try {
            if (!(await this.directoryExists(dirPath))) {
                console.warn(`目录不存在: ${dirPath}`);
                return;
            }

            const items = await fs.readdir(dirPath);
            
            for (const item of items) {
                const itemPath = path.join(dirPath, item);
                const stat = await fs.stat(itemPath);
                
                if (stat.isFile()) {
                    // 直接在根目录的文件
                    const key = `${prefix}:${item.toLowerCase()}`;
                    this.fileCache.set(key, itemPath);
                } else if (stat.isDirectory()) {
                    // 子目录中的文件
                    await this.cacheSubDirectory(itemPath, `${prefix}:${item}`);
                }
            }
            
        } catch (error) {
            console.error(`递归缓存目录失败 ${dirPath}:`, error);
        }
    }

    /**
     * 缓存子目录
     */
    async cacheSubDirectory(dirPath, prefix) {
        try {
            const files = await fs.readdir(dirPath);
            
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stat = await fs.stat(filePath);
                
                if (stat.isFile()) {
                    const key = `${prefix}:${file.toLowerCase()}`;
                    this.fileCache.set(key, filePath);
                }
            }
            
        } catch (error) {
            console.error(`缓存子目录失败 ${dirPath}:`, error);
        }
    }

    /**
     * 查找文件
     */
    async locateFile(fileName, pathPrefix = null) {
        // 确保缓存已初始化
        await this.initializeCache();

        const lowerFileName = fileName.toLowerCase();
        
        if (pathPrefix) {
            // 带路径前缀的搜索
            return await this.locateFileWithPath(lowerFileName, pathPrefix);
        } else {
            // 直接文件名搜索
            return await this.locateFileDirectly(lowerFileName);
        }
    }

    /**
     * 直接搜索文件（在pic和类脑角色卡目录）
     */
    async locateFileDirectly(fileName) {
        const results = [];

        // 1. 在pic目录搜索
        const picKey = `pic:${fileName}`;
        if (this.fileCache.has(picKey)) {
            results.push({
                path: this.fileCache.get(picKey),
                location: 'pic',
                matchType: 'exact'
            });
        }

        // 2. 在类脑角色卡根目录搜索
        const brainCardKey = `brainCard:${fileName}`;
        if (this.fileCache.has(brainCardKey)) {
            results.push({
                path: this.fileCache.get(brainCardKey),
                location: 'brainCard',
                matchType: 'exact'
            });
        }

        // 3. 如果在根目录没找到，递归搜索所有子目录
        if (results.length === 0) {
            const subDirResults = await this.searchAllSubDirectories(fileName);
            results.push(...subDirResults);
        }

        return results;
    }

    /**
     * 在所有子目录中搜索文件
     */
    async searchAllSubDirectories(fileName) {
        const results = [];
        const lowerFileName = fileName.toLowerCase();

        // 遍历缓存中的所有条目
        for (const [key, filePath] of this.fileCache.entries()) {
            // 获取缓存文件的文件名
            const cachedFileName = path.basename(filePath).toLowerCase();
            
            // 检查是否精确匹配文件名
            if (cachedFileName === lowerFileName) {
                // 解析缓存键来确定位置信息
                const location = this.parseLocationFromKey(key);
                
                results.push({
                    path: filePath,
                    location: location,
                    matchType: 'recursive'
                });
                
                console.log(`🔍 在子目录中找到文件: ${fileName} -> ${location}/${cachedFileName}`);
            }
        }

        // 按位置排序，优先显示更简单的路径
        results.sort((a, b) => {
            const aDepth = (a.location.match(/\//g) || []).length;
            const bDepth = (b.location.match(/\//g) || []).length;
            return aDepth - bDepth;
        });

        return results;
    }

    /**
     * 从缓存键解析位置信息
     */
    parseLocationFromKey(key) {
        const parts = key.split(':');
        
        if (parts[0] === 'pic') {
            return 'pic';
        } else if (parts[0] === 'characters') {
            return 'characters';
        } else if (parts[0] === 'brainCard') {
            if (parts.length === 2) {
                // brainCard:filename.png -> 根目录
                return 'brainCard';
            } else {
                // brainCard:subdir:filename.png -> 子目录
                return `brainCard/${parts[1]}`;
            }
        }
        
        return 'unknown';
    }

    /**
     * 带路径前缀搜索
     */
    async locateFileWithPath(fileName, pathPrefix) {
        const results = [];

        if (pathPrefix.toLowerCase() === 'characters') {
            // characters路径在pic目录内
            const characterKey = `characters:${fileName}`;
            if (this.fileCache.has(characterKey)) {
                results.push({
                    path: this.fileCache.get(characterKey),
                    location: 'characters',
                    matchType: 'exact'
                });
            }
        } else {
            // 其他路径前缀在类脑角色卡目录内
            const brainCardKey = `brainCard:${pathPrefix}:${fileName}`;
            if (this.fileCache.has(brainCardKey)) {
                results.push({
                    path: this.fileCache.get(brainCardKey),
                    location: `brainCard/${pathPrefix}`,
                    matchType: 'exact'
                });
            }
        }

        // 如果没找到，尝试在对应目录中实时搜索
        if (results.length === 0) {
            const fallbackResult = await this.fallbackSearch(fileName, pathPrefix);
            if (fallbackResult) {
                results.push(fallbackResult);
            }
        }

        return results;
    }

    /**
     * 模糊搜索
     */
    async fuzzySearch(targetFileName) {
        const results = [];
        const targetWithoutExt = path.parse(targetFileName).name.toLowerCase();

        for (const [key, filePath] of this.fileCache.entries()) {
            const cachedFileName = path.basename(filePath).toLowerCase();
            const cachedWithoutExt = path.parse(cachedFileName).name.toLowerCase();

            // 检查文件名是否包含目标文件名或目标文件名包含缓存文件名
            if (cachedWithoutExt.includes(targetWithoutExt) || targetWithoutExt.includes(cachedWithoutExt)) {
                const [location] = key.split(':');
                results.push({
                    path: filePath,
                    location: location.replace('brainCard:', 'brainCard/'),
                    matchType: 'fuzzy',
                    similarity: this.calculateSimilarity(targetWithoutExt, cachedWithoutExt)
                });
            }
        }

        // 按相似度排序
        results.sort((a, b) => b.similarity - a.similarity);
        
        return results.slice(0, 5); // 返回最相似的5个结果
    }

    /**
     * 计算字符串相似度
     */
    calculateSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) {
            return 1.0;
        }
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }

    /**
     * 计算编辑距离
     */
    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }

    /**
     * 后备搜索（实时搜索目录）
     */
    async fallbackSearch(fileName, pathPrefix) {
        try {
            let searchDir;
            
            if (pathPrefix.toLowerCase() === 'characters') {
                searchDir = this.characterDir;
            } else {
                searchDir = path.join(this.brainCardDir, pathPrefix);
            }

            if (!(await this.directoryExists(searchDir))) {
                return null;
            }

            const files = await fs.readdir(searchDir);
            const matchedFile = files.find(file => file.toLowerCase() === fileName);
            
            if (matchedFile) {
                return {
                    path: path.join(searchDir, matchedFile),
                    location: pathPrefix.toLowerCase() === 'characters' ? 'characters' : `brainCard/${pathPrefix}`,
                    matchType: 'fallback'
                };
            }
            
        } catch (error) {
            console.error(`后备搜索失败:`, error);
        }
        
        return null;
    }

    /**
     * 检查目录是否存在
     */
    async directoryExists(dirPath) {
        try {
            const stat = await fs.stat(dirPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(filePath) {
        try {
            const stat = await fs.stat(filePath);
            return stat.isFile();
        } catch {
            return false;
        }
    }

    /**
     * 获取文件统计信息
     */
    getCacheStats() {
        const stats = {
            totalFiles: this.fileCache.size,
            locations: {}
        };

        for (const key of this.fileCache.keys()) {
            const location = key.split(':')[0];
            stats.locations[location] = (stats.locations[location] || 0) + 1;
        }

        return stats;
    }
}

module.exports = FileLocator; 