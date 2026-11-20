// src/modules/channelArchive/services/backupService.js
const fs = require('node:fs');
const path = require('node:path');
const { buildBackupRecord } = require('./contentFormatter');
const { readRecords } = require('./historyReader');
const { createZip } = require('../utils/zipWriter');
const { sanitizeFileName } = require('../utils/text');

function writeChunk(stream, chunk) {
    return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        stream.once('error', onError);
        const ok = stream.write(chunk, error => {
            if (error) reject(error);
        });
        if (ok) {
            stream.removeListener('error', onError);
            resolve();
        } else {
            stream.once('drain', () => {
                stream.removeListener('error', onError);
                resolve();
            });
        }
    });
}

async function writeBackupJson({ manifest, meta, outPath }) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
    let count = 0;
    try {
        await writeChunk(stream, `{\n"channel": ${JSON.stringify(meta)},\n"messages": [\n`);
        let first = true;
        for await (const record of readRecords(manifest)) {
            const backupRecord = buildBackupRecord(record);
            const prefix = first ? '' : ',\n';
            first = false;
            await writeChunk(stream, `${prefix}${JSON.stringify(backupRecord)}`);
            count += 1;
        }
        await writeChunk(stream, '\n]\n}\n');
        await new Promise((resolve, reject) => {
            stream.end(error => (error ? reject(error) : resolve()));
        });
    } catch (error) {
        stream.destroy();
        throw error;
    }
    const stats = fs.statSync(outPath);
    return { messageCount: count, bytes: stats.size };
}

async function createBackupArchive({ manifest, meta, outDir, baseName }) {
    fs.mkdirSync(outDir, { recursive: true });
    const safeBase = sanitizeFileName(baseName, 'channel');
    const jsonPath = path.join(outDir, `${safeBase}.json`);
    const zipPath = path.join(outDir, `${safeBase}.zip`);

    const result = await writeBackupJson({ manifest, meta, outPath: jsonPath });
    createZip(zipPath, [{ name: `${safeBase}.json`, path: jsonPath }]);
    const stats = fs.statSync(zipPath);

    return {
        zipPath,
        jsonPath,
        messageCount: result.messageCount,
        zipSize: stats.size,
        jsonSize: result.bytes,
    };
}

module.exports = {
    createBackupArchive,
    writeBackupJson,
};
