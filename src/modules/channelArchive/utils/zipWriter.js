// src/modules/channelArchive/utils/zipWriter.js
const fs = require('node:fs');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

class ZipWriter {
    constructor(filePath) {
        fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
        this.filePath = filePath;
        this.fd = fs.openSync(filePath, 'w');
        this.offset = 0;
        this.entries = [];
        this.closed = false;
    }

    addBuffer(entryName, buffer) {
        if (this.closed) throw new Error('ZIP 已关闭');
        const name = Buffer.from(String(entryName), 'utf8');
        const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const crc = crc32(raw);
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        const useDeflate = deflated.length < raw.length;
        const data = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const { dosTime, dosDate } = dosDateTime();
        const flags = 0x0800; // UTF-8

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(flags, 6);
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(raw.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);

        const localOffset = this.offset;
        fs.writeSync(this.fd, localHeader);
        fs.writeSync(this.fd, name);
        fs.writeSync(this.fd, data);
        this.offset += localHeader.length + name.length + data.length;

        this.entries.push({
            name,
            flags,
            method,
            dosTime,
            dosDate,
            crc,
            compressedSize: data.length,
            uncompressedSize: raw.length,
            localOffset,
        });
    }

    addFile(entryName, filePath) {
        this.addBuffer(entryName, fs.readFileSync(filePath));
    }

    finish() {
        if (this.closed) return this.filePath;
        const centralStart = this.offset;
        for (const entry of this.entries) {
            const header = Buffer.alloc(46);
            header.writeUInt32LE(0x02014b50, 0);
            header.writeUInt16LE(20, 4);
            header.writeUInt16LE(20, 6);
            header.writeUInt16LE(entry.flags, 8);
            header.writeUInt16LE(entry.method, 10);
            header.writeUInt16LE(entry.dosTime, 12);
            header.writeUInt16LE(entry.dosDate, 14);
            header.writeUInt32LE(entry.crc, 16);
            header.writeUInt32LE(entry.compressedSize, 20);
            header.writeUInt32LE(entry.uncompressedSize, 24);
            header.writeUInt16LE(entry.name.length, 28);
            header.writeUInt16LE(0, 30);
            header.writeUInt16LE(0, 32);
            header.writeUInt16LE(0, 34);
            header.writeUInt16LE(0, 36);
            header.writeUInt32LE(0, 38);
            header.writeUInt32LE(entry.localOffset, 42);
            fs.writeSync(this.fd, header);
            fs.writeSync(this.fd, entry.name);
            this.offset += header.length + entry.name.length;
        }

        const centralSize = this.offset - centralStart;
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(centralSize, 12);
        end.writeUInt32LE(centralStart, 16);
        end.writeUInt16LE(0, 20);
        fs.writeSync(this.fd, end);
        this.offset += end.length;

        fs.closeSync(this.fd);
        this.closed = true;
        return this.filePath;
    }
}

function createZip(zipPath, files = []) {
    const writer = new ZipWriter(zipPath);
    for (const file of files) {
        writer.addFile(file.name, file.path);
    }
    return writer.finish();
}

module.exports = {
    ZipWriter,
    createZip,
    crc32,
};
