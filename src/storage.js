import { createSingleMmdbGateway } from './geoip/storage.js';
import { createConfiguredMmdbGateway } from './geoip/source.js';

export function createStore({ storage, env }) {
    const sql = storage.sql;
    sql.exec(`
        CREATE TABLE IF NOT EXISTS single_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mmdb_meta (
            name TEXT PRIMARY KEY, etag TEXT, updated_at INTEGER NOT NULL,
            total_size INTEGER NOT NULL, build_epoch INTEGER, source_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS mmdb_chunks (
            name TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
            PRIMARY KEY (name, idx)
        );
    `);

    const read = () => [...sql.exec('SELECT value FROM single_store WHERE key = ?', 'data')][0]?.value ?? null;
    return {
        async getData() { return read(); },
        async putData(data) {
            sql.exec('INSERT OR REPLACE INTO single_store (key, value) VALUES (?, ?)', 'data', data);
        },
        mmdbGateway: createConfiguredMmdbGateway({ gateway: createSingleMmdbGateway({ storage }), env }),
    };
}
