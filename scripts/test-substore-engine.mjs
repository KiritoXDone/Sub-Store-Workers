import assert from 'node:assert/strict';
import test from 'node:test';
import { runSubStoreHttp } from '../src/substore/http.js';
import { runSubStoreCron } from '../src/substore/cron.js';
import { getActiveSubStoreContext } from '../src/substore/context.js';
import { requestContext } from '../src/context.js';
import { createNotificationGateway } from '../src/notifications.js';

test('single-store requests keep isolated snapshots, await saves and route cron sync', async () => {
    const old = {
        loader: globalThis.__loadSubStoreEntry__,
        migrate: globalThis.__substore_migrate__,
        dispatch: globalThis.__substore_dispatch__,
        geo: globalThis.__surge_geoip_cache__,
        process: globalThis.process,
    };
    globalThis.__surge_geoip_cache__ = { nextCheckAt: Date.now() + 60000, countryReader: null, asnReader: null };
    const migrations = [];
    const routes = [];
    globalThis.__loadSubStoreEntry__ = async () => {
        const context = getActiveSubStoreContext();
        await requestContext.exit(async () => {
            assert.equal(getActiveSubStoreContext(), context);
            context.cache.settings = {};
            assert.equal(globalThis.$persistentStore.write(JSON.stringify(context.cache), 'sub-store'), true);
        });
        globalThis.__substore_migrate__ = () => migrations.push(getActiveSubStoreContext().cache.label);
        globalThis.__substore_dispatch__ = (request) => {
            routes.push(request.url);
            const initial = getActiveSubStoreContext().cache.label;
            setTimeout(() => {
                const context = getActiveSubStoreContext();
                assert.equal(context.cache.label, initial);
                assert.equal(context.user, undefined);
                context.cache.touched = true;
                context.persistentStore.write(JSON.stringify(context.cache), 'sub-store');
                context.done({ response: { status: initial === 'partial' ? 500 : 200, body: initial, headers: {} } });
            }, initial === 'A' ? 10 : 0);
        };
    };
    const saved = [];
    const makeEnv = () => ({
        SUB_STORE_PUSH_SERVICE: 'https://notify.invalid/secret',
        __saveSubStoreData: async (value) => {
            await new Promise(resolve => setTimeout(resolve, 1));
            saved.push(JSON.parse(value));
        },
    });
    const data = label => JSON.stringify({ 'sub-store': JSON.stringify({ label }) });
    try {
        const responses = await Promise.all(['A', 'B'].map(label => runSubStoreHttp({
            data: data(label), env: makeEnv(), request: new Request(`https://example.test/private/${label}`), subStorePath: `/${label}`,
        })));
        assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['A', 'B']);
        assert.deepEqual(saved.map(item => JSON.parse(item['sub-store']).label).sort(), ['A', 'B']);
        assert.deepEqual(JSON.parse(saved.find(item => JSON.parse(item['sub-store']).label === 'A')['sub-store']).settings, {});
        assert.ok(saved.every(item => !JSON.stringify(item).includes('notify.invalid')));
        assert.deepEqual(migrations.sort(), ['A', 'B']);
        assert.equal(getActiveSubStoreContext(), null);

        await runSubStoreCron({ data: data('cron'), env: makeEnv() });
        assert.ok(routes.includes('https://substore.internal/api/sync/artifacts'));
        assert.equal(JSON.parse(saved.at(-1)['sub-store']).label, 'cron');
        await assert.rejects(runSubStoreCron({ data: data('partial'), env: makeEnv() }), /Cron sync returned 500/);
        assert.equal(JSON.parse(saved.at(-1)['sub-store']).label, 'partial');
        await assert.rejects(runSubStoreHttp({
            data: data('fail'), env: { __saveSubStoreData: async () => { throw new Error('write failed'); } },
            request: new Request('https://example.test/private/fail'), subStorePath: '/fail',
        }), /write failed/);
    } finally {
        globalThis.__loadSubStoreEntry__ = old.loader;
        globalThis.__substore_migrate__ = old.migrate;
        globalThis.__substore_dispatch__ = old.dispatch;
        globalThis.__surge_geoip_cache__ = old.geo;
        globalThis.process = old.process;
    }
});

test('environment push service supports HTTP templates and Shoutrrr without configuration writes', async () => {
    const original = globalThis.fetch;
    const requests = [];
    const pending = [];
    globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return new Response('{}'); };
    try {
        const lifetime = { waitUntil: task => pending.push(task) };
        createNotificationGateway(undefined, lifetime).post('Ignored', '', '');
        createNotificationGateway('https://example.test/[推送标题]?body=[推送内容]', lifetime).post('标题', '摘要', '内容');
        createNotificationGateway('ntfy://ntfy.sh/local-test', lifetime).post('Title', 'Subtitle', 'Body');
        await Promise.all(pending);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].url, 'https://example.test/%E6%A0%87%E9%A2%98?body=%E6%91%98%E8%A6%81%0A%E5%86%85%E5%AE%B9');
        assert.ok(requests[1].url.startsWith('https://ntfy.sh/'));
        assert.ok(String(requests[1].init.body).includes('Body'));
    } finally { globalThis.fetch = original; }
});
