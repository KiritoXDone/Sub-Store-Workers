import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/storage.js';

test('SQLite store saves data and validates configured MMDB before replacing it', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = {
        sql: {
            exec(query, ...params) {
                if (!params.length && query.includes('CREATE TABLE')) { db.exec(query); return []; }
                const statement = db.prepare(query);
                return /^\s*SELECT/i.test(query) ? statement.all(...params) : (statement.run(...params), []);
            },
        },
        transactionSync(callback) {
            db.exec('BEGIN');
            try { const result = callback(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        },
    };
    const str = (value) => Buffer.concat([Buffer.from([0x40 + value.length]), Buffer.from(value)]);
    const uint = (value) => Buffer.from([0xa1, value]);
    const fixture = Buffer.concat([
        Buffer.alloc(16), Buffer.from('abcdef4d61784d696e642e636f6d', 'hex'), Buffer.from([0xe3]),
        str('record_size'), uint(24), str('ip_version'), uint(4), str('node_count'), uint(0),
    ]);
    const env = { MMDB_COUNTRY_URL: 'https://mmdb.test/country', MMDB_ASN_URL: 'https://mmdb.test/asn' };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => new Response(url.endsWith('/bad') ? new Uint8Array([1]) : fixture, { headers: { ETag: 'v1' } });
    try {
        const store = createStore({ storage, env });
        assert.equal(await store.getData(), null);
        await store.putData('{"value":1}');
        assert.equal(await store.getData(), '{"value":1}');
        await store.putData('{"value":2}');
        assert.equal(await store.getData(), '{"value":2}');

        const metadata = await store.mmdbGateway.getMmdbMeta();
        assert.equal(metadata.length, 2);
        assert.ok(metadata.every((item) => item.sourceUrl.startsWith('sha256:') && !item.sourceUrl.includes('mmdb.test')));
        assert.deepEqual((await store.mmdbGateway.getMmdbFile('Country.mmdb')).data, new Uint8Array(fixture));
        env.MMDB_COUNTRY_URL = 'https://mmdb.test/bad';
        await store.mmdbGateway.getMmdbMeta();
        assert.deepEqual((await store.mmdbGateway.getMmdbFile('Country.mmdb')).data, new Uint8Array(fixture));
    } finally {
        globalThis.fetch = originalFetch;
        db.close();
    }
});
