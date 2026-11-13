const CHUNK_SIZE = 256 * 1024;

export function createSingleMmdbGateway({ storage }) {
    const sql = storage.sql;

    function getMeta(name) {
        return [...sql.exec(
            'SELECT name, etag, updated_at AS updatedAt, total_size AS size, build_epoch AS buildEpoch, source_hash AS sourceUrl FROM mmdb_meta WHERE name = ?',
            name,
        )][0] ?? null;
    }

    return {
        async getMmdbMeta() {
            return [...sql.exec('SELECT name, etag, updated_at AS updatedAt, total_size AS size, build_epoch AS buildEpoch, source_hash AS sourceUrl FROM mmdb_meta ORDER BY name')];
        },

        async getMmdbFile(name) {
            const meta = getMeta(name);
            if (!meta || !meta.size) return null;
            const data = new Uint8Array(Number(meta.size));
            let offset = 0;
            for (const row of sql.exec('SELECT data FROM mmdb_chunks WHERE name = ? ORDER BY idx', name)) {
                const chunk = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
                if (offset + chunk.byteLength > data.byteLength) return null;
                data.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return offset === data.byteLength ? { ...meta, data } : null;
        },

        async putMmdbFile({ name, etag, data, buildEpoch, sourceUrl, updatedAt = Date.now() }) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            storage.transactionSync(() => {
                sql.exec('DELETE FROM mmdb_chunks WHERE name = ?', name);
                sql.exec('DELETE FROM mmdb_meta WHERE name = ?', name);
                sql.exec(
                    'INSERT INTO mmdb_meta (name, etag, updated_at, total_size, build_epoch, source_hash) VALUES (?, ?, ?, ?, ?, ?)',
                    name, etag || '', updatedAt, bytes.byteLength, buildEpoch ?? null, sourceUrl || '',
                );
                for (let offset = 0, index = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, index += 1) {
                    sql.exec('INSERT INTO mmdb_chunks (name, idx, data) VALUES (?, ?, ?)', name, index, bytes.subarray(offset, offset + CHUNK_SIZE));
                }
            });
            return { success: true, totalSize: bytes.byteLength, chunkSize: CHUNK_SIZE, chunks: Math.ceil(bytes.byteLength / CHUNK_SIZE) };
        },
    };
}
