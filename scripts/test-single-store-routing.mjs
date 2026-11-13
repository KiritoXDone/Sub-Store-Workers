import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/router.js';

const env = { SUB_STORE_FRONTEND_BACKEND_PATH: '/local-test-backend' };
test('single private backend forwards management requests without a user route', async () => {
    const response = await handleRequest(new Request('https://test/local-test-backend/api/subs?target=JSON', {
        method: 'POST', body: '{"name":"example"}', headers: { 'Content-Type': 'application/json' },
    }), env, async request => {
        assert.equal(new URL(request.url).pathname, '/api/subs');
        assert.equal(new URL(request.url).search, '?target=JSON');
        assert.equal(await request.text(), '{"name":"example"}');
        return new Response('stored');
    });
    assert.equal(await response.text(), 'stored');
});

test('public shares preserve their token; dashboard, old users and internal routes are absent', async () => {
    let calls = 0;
    const forward = async request => { calls++; assert.equal(new URL(request.url).searchParams.get('token'), 'old-token'); return new Response('share'); };
    assert.equal((await handleRequest(new Request('https://test/share/sub/example?token=old-token'), env, forward)).status, 200);
    for (const path of ['/dashboard/', '/api/dashboard/auth/login', '/old-user/api/subs', '/local-test-backendx/api/subs', '/local-test-backend/_internal/cron']) {
        assert.equal((await handleRequest(new Request('https://test' + path), env, forward)).status, 404);
    }
    assert.equal((await handleRequest(new Request('https://test/share/sub/example', { method: 'POST' }), env, forward)).status, 404);
    assert.equal(calls, 1);
    assert.equal((await handleRequest(new Request('https://test/local-test-backend/api/subs', { method: 'OPTIONS' }), env, forward)).status, 204);
    assert.equal((await handleRequest(new Request('https://test/api/subs'), {}, forward)).status, 503);
});


test('official frontend assets share the domain without exposing removed management APIs', async () => {
    let assets = 0;
    const fetchAsset = async () => { assets++; return new Response('official frontend'); };
    const backend = () => { throw new Error('Unexpected backend dispatch'); };
    assert.equal(await (await handleRequest(new Request('https://test/'), env, backend, fetchAsset)).text(), 'official frontend');
    assert.equal((await handleRequest(new Request('https://test/assets/app.js'), env, backend, fetchAsset)).status, 200);
    assert.equal((await handleRequest(new Request('https://test/dashboard/'), env, backend, fetchAsset)).status, 404);
    assert.equal((await handleRequest(new Request('https://test/share/unknown/name'), env, backend, fetchAsset)).status, 404);
    assert.equal((await handleRequest(new Request('https://test/api/subs'), env, backend, fetchAsset)).status, 404);
    assert.equal(assets, 2);
});
