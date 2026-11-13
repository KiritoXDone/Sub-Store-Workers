import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/adapters/http-client.js';
import { createSubStoreRequestContext, getActiveSubStoreContext, runWithSubStoreContext } from '../src/atoms/substore/subStoreRequestContext.js';
import { ensureGeoDbLoaded } from '../src/atoms/surge/geoip/ensureGeoDbLoaded.js';
import { putUserDataFromSnapshot } from '../src/atoms/user/putUserDataFromSnapshot.js';
import { initSubStore } from '../src/core/substore-loader.js';
import { updateUserSettings } from '../src/dashboard/atoms/user/updateUserSettings.js';
import { runCronBatch } from '../src/molecules/http/runCronBatch.js';
import { putUserDataString } from '../src/molecules/user/putUserDataString.js';
import { createDenoUserGateway } from '../src/platform/deno/runtime/userGateway.js';
import { createUserRequestQueue } from '../src/platform/workers/runtime/serializeUserRequests.js';

const request = (options, method = 'get') => new Promise((resolve) => {
    createHttpClient()[method](options, (error, response, body) => resolve({ error, response, body }));
});

test('each user runs the shared migration in its own request context', async () => {
    const previous = {
        loader: globalThis.__loadSubStoreEntry__,
        migrate: globalThis.__substore_migrate__,
        dispatch: globalThis.__substore_dispatch__,
    };
    const migrations = [];
    const writes = [];
    const dispatched = [];
    globalThis.__loadSubStoreEntry__ = async () => {
        globalThis.__substore_migrate__ = () => {
            const context = getActiveSubStoreContext();
            migrations.push(context.user.id);
            if (!context.cache.schemaVersion) {
                context.cache.subs ??= [];
                context.cache.schemaVersion = '2.0';
                context.persistentStore.write(JSON.stringify(context.cache), 'sub-store');
            }
        };
        globalThis.__substore_dispatch__ = () => {
            const context = getActiveSubStoreContext();
            dispatched.push({ id: context.user.id, data: structuredClone(context.cache) });
        };
    };
    const makeContext = (id, cache) => createSubStoreRequestContext({
        requestId: `migration-${id}`, user: { id }, cache,
        persistentStore: { write: (value) => writes.push({ id, data: JSON.parse(value) }) },
    });
    try {
        await runWithSubStoreContext(makeContext(1, { subs: [{ name: 'existing' }] }), () => initSubStore({}));
        await runWithSubStoreContext(makeContext(2, {}), () => initSubStore({}));
        assert.deepEqual(migrations, [1, 2]);
        assert.deepEqual(writes, [
            { id: 1, data: { subs: [{ name: 'existing' }], schemaVersion: '2.0' } },
            { id: 2, data: { subs: [], schemaVersion: '2.0' } },
        ]);
        assert.deepEqual(dispatched, writes);
    } finally {
        globalThis.__loadSubStoreEntry__ = previous.loader;
        globalThis.__substore_migrate__ = previous.migrate;
        globalThis.__substore_dispatch__ = previous.dispatch;
    }
});

test('HTTP timeout covers the response body and caller abort reaches fetch', async () => {
    const originalFetch = globalThis.fetch;
    let seenSignal;
    globalThis.fetch = async (_url, { signal }) => {
        seenSignal = signal;
        return {
            status: 200,
            headers: new Headers(),
            text: () => new Promise((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        };
    };
    try {
        const started = Date.now();
        const timedOut = await request({ url: 'https://example.test', timeout: 0.02 });
        assert.ok(timedOut.error);
        assert.ok(Date.now() - started < 1000);
        assert.equal(seenSignal.aborted, true);

        const controller = new AbortController();
        const pending = request({ url: 'https://example.test', signal: controller.signal });
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort(new Error('caller cancelled'));
        assert.match((await pending).error, /caller cancelled/);
        assert.equal(seenSignal.aborted, true);

        const bodies = [];
        globalThis.fetch = async (_url, options) => {
            bodies.push(options.body);
            return new Response('ok');
        };
        const binary = new Uint8Array([1, 2, 3]);
        for (const body of [binary, '', 0, { value: 1 }]) {
            assert.equal((await request({ url: 'https://example.test', body }, 'post')).error, null);
        }
        assert.deepEqual(bodies, [binary, '', 0, '{"value":1}']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('cron bounds concurrency and only advances past a successful prefix', async () => {
    let active = 0;
    let maxActive = 0;
    let cursor = null;
    const gateway = {
        getSettings: async () => ({}),
        listUsers: async ({ afterId }) => afterId === 0 ? { results: [1, 2, 3, 4, 5].map((id) => ({ id })) } : { results: [] },
        triggerUserCron: async ({ user }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setImmediate(resolve));
            active -= 1;
            return user.id !== 3;
        },
        patchSettings: async ({ patch }) => { cursor = patch.cronLastUserId; return true; },
    };
    const result = await runCronBatch({
        entryGateway: gateway,
        settingsNormalizer: () => ({ batchSize: 10, maxUsers: 10, timeBudgetMs: 10000, lastUserId: 0 }),
    });
    assert.equal(maxActive, 4);
    assert.deepEqual(result, { processed: 2, finishedAll: false, stopReason: 'user-failed' });
    assert.equal(cursor, 2);

    gateway.triggerUserCron = async () => true;
    gateway.listUsers = async ({ afterId }) => {
        if (!afterId) return { results: [{ id: 1 }, { id: 2 }] };
        throw new Error('list failed');
    };
    const listingFailure = await runCronBatch({
        entryGateway: gateway,
        settingsNormalizer: () => ({ batchSize: 10, maxUsers: 10, timeBudgetMs: 10000, lastUserId: 0 }),
    });
    assert.deepEqual(listingFailure, { processed: 2, finishedAll: false, stopReason: 'error' });
    assert.equal(cursor, 2);
});

test('Deno rejects stale snapshots and batches access log cleanup; Workers queue survives errors', async () => {
    let row = { value: 'old', revision: '1' };
    let revision = 1;
    let cleanups = 0;
    const query = async (sql, params = []) => {
        if (sql.startsWith('SELECT value, xmin')) return { rows: row ? [row] : [] };
        if (sql.startsWith('UPDATE user_store SET value')) {
            if (!row || row.revision !== params[4]) return { rowCount: 0 };
            row = { value: params[2], revision: String(++revision) };
            return { rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO user_store') && sql.includes('DO NOTHING')) {
            if (row) return { rowCount: 0 };
            row = { value: params[2], revision: String(++revision) };
            return { rowCount: 1 };
        }
        if (sql.startsWith('DELETE FROM download_access_log')) cleanups += 1;
        return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const gateway = createDenoUserGateway({ pool });
    const first = await gateway.getUserDataSnapshot(1);
    const second = await gateway.getUserDataSnapshot(1);
    await putUserDataFromSnapshot(gateway, 1, first, 'new');
    await assert.rejects(putUserDataFromSnapshot(gateway, 1, second, 'stale'), { code: 'USER_DATA_CONFLICT' });
    assert.equal(row.value, 'new');
    await gateway.appendAccessLog(1, { ts: 1, kind: 'sub', name: 'a' });
    for (let i = 0; i < 64; i += 1) await gateway.appendAccessLog(1, { ts: 2, kind: 'sub', name: 'b' });
    assert.equal(cleanups, 2);

    const queue = createUserRequestQueue();
    const order = [];
    const a = queue(async () => { order.push('start'); await new Promise((resolve) => setImmediate(resolve)); order.push('end'); throw new Error('failed'); });
    const b = queue(async () => { order.push('next'); });
    await assert.rejects(a);
    await b;
    assert.deepEqual(order, ['start', 'end', 'next']);
});

test('settings retries a conflicting snapshot and Worker conditional writes reject stale data', async () => {
    let data = JSON.stringify({ 'sub-store': 'first' });
    let attempts = 0;
    const userGateway = {
        getUserDataSnapshot: async () => ({ data }),
        compareAndPutUserDataString: async (_id, snapshot, next) => {
            attempts += 1;
            if (attempts === 1) data = JSON.stringify({ 'sub-store': 'updated' });
            if (data !== snapshot.data) return false;
            data = next;
            return true;
        },
    };
    assert.equal(await updateUserSettings(userGateway, 1, { cronEnabled: false }), true);
    assert.deepEqual(JSON.parse(data), { 'sub-store': 'updated', __settings__: { cronEnabled: false } });
    const localGateway = {
        getUserDataString: async () => data,
        putUserDataString: async (_id, value) => { data = value; },
    };
    const conflict = await putUserDataString({
        request: new Request('https://user/_internal/user-data', {
            method: 'PUT', headers: { 'X-User-Id': '1' },
            body: JSON.stringify({ expectedData: 'stale', data: {} }),
        }),
        userGateway: localGateway,
    });
    assert.equal(conflict.status, 409);
    assert.equal(JSON.parse(data)['sub-store'], 'updated');
});

test('GeoIP retries missing files and replaces both readers after a version change', async () => {
    delete globalThis.__surge_geoip_cache__;
    const str = (value) => Buffer.concat([Buffer.from([0x40 + value.length]), Buffer.from(value)]);
    const uint = (value) => Buffer.from([0xa1, value]);
    const fixture = Buffer.concat([
        Buffer.alloc(16), Buffer.from('abcdef4d61784d696e642e636f6d', 'hex'), Buffer.from([0xe3]),
        str('record_size'), uint(24), str('ip_version'), uint(4), str('node_count'), uint(0),
    ]);
    const padded = Buffer.concat([Buffer.alloc(7), fixture, Buffer.alloc(3)]);
    const data = padded.subarray(7, 7 + fixture.length);
    let version = 0;
    let valid = true;
    const names = ['Country.mmdb', 'Country-asn.mmdb'];
    const gateway = {
        getMmdbMeta: async () => version ? names.map((name) => ({ name, etag: String(version), updatedAt: version, size: data.length })) : [],
        getMmdbFile: async (name) => ({ name, etag: String(version), updatedAt: version, data: valid ? data : new Uint8Array([1]) }),
    };
    try {
        const cache = await ensureGeoDbLoaded({ __mmdbGateway: gateway });
        assert.equal(cache.readyPromise, null);
        assert.equal(cache.countryReader, null);
        version = 1;
        cache.nextCheckAt = 0;
        await ensureGeoDbLoaded({ __mmdbGateway: gateway });
        const oldCountry = cache.countryReader;
        assert.ok(oldCountry && cache.asnReader);
        version = 2;
        valid = false;
        cache.nextCheckAt = 0;
        await ensureGeoDbLoaded({ __mmdbGateway: gateway });
        assert.equal(cache.countryReader, oldCountry);
        valid = true;
        cache.nextCheckAt = 0;
        await ensureGeoDbLoaded({ __mmdbGateway: gateway });
        assert.notEqual(cache.countryReader, oldCountry);
    } finally {
        delete globalThis.__surge_geoip_cache__;
    }
});
