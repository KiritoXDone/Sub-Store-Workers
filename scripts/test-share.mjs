import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parse } from 'acorn';
import { transformShareSupport } from './substore-share-transform.mjs';
import { handleShareRequest } from '../src/molecules/http/handleShareRequest.js';

function loadTokenApi() {
    let source = transformShareSupport(fs.readFileSync(new URL('../sub-store/backend/src/restful/token.js', import.meta.url), 'utf8'), '/restful/token.js');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of [...ast.body].reverse()) {
        if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration') source = source.slice(0, node.start) + source.slice(node.end);
        else if (node.type === 'ExportDefaultDeclaration') source = source.slice(0, node.start) + source.slice(node.declaration.start);
    }
    source = source.replace('const nanoid = eval(`require("nanoid")`);', 'const nanoid = {};');
    const data = { tokens: [], subs: [{ name: 'demo' }], files: [], collections: [] };
    const $ = { read: key => data[key], write: (value, key) => { data[key] = value; } };
    const names = ['$', 'TOKENS_KEY', 'SUBS_KEY', 'FILES_KEY', 'COLLECTIONS_KEY', 'RequestInvalidError', 'ResourceNotFoundError', 'insertByPosition', 'getCreateItemPosition', 'normalizeAgePublicKeyConfig'];
    const api = new Function(...names, source + '\nreturn {createTokenItem, consumeShareToken, deleteTokenItem};')($, 'tokens', 'subs', 'files', 'collections', Error, Error, (items, item) => items.push(item), () => 'bottom', () => {});
    return { api, data };
}

test('upstream share tokens retain expiry, count and revocation with tenant routing', () => {
    const old = globalThis.__substore_get_active_context__;
    globalThis.__substore_get_active_context__ = () => ({ user: { id: 7 } });
    try {
        const { api, data } = loadTokenApi();
        const item = api.createTokenItem({ type: 'sub', name: 'demo' }, { mode: 'count', count: 1 });
        assert.match(item.token, /^u7\.[a-f0-9]{32}$/);
        assert.equal(api.consumeShareToken({ token: item.token, pathname: '/share/sub/other' }), null);
        assert.equal(api.consumeShareToken({ token: item.token, pathname: '/share/sub/demo' }).usedCount, 1);
        assert.equal(api.consumeShareToken({ token: item.token, pathname: '/share/sub/demo' }), null);
        const custom = api.createTokenItem({ type: 'sub', name: 'demo', token: 'custom' });
        assert.equal(custom.token, 'u7.custom');
        data.tokens.find(t => t.token === custom.token).exp = Date.now() - 1;
        assert.equal(api.consumeShareToken({ token: custom.token, pathname: '/share/sub/demo' }), null);
        api.deleteTokenItem(custom.token, 'sub', 'demo');
        assert.equal(api.consumeShareToken({ token: custom.token, pathname: '/share/sub/demo' }), null);
    } finally { globalThis.__substore_get_active_context__ = old; }
});

test('public share entry routes only a scoped GET without exposing the secret path', async () => {
    const calls = [];
    const entryGateway = {
        getUserById: async ({ userId }) => userId === 7 ? { id: 7, path: 'private-path' } : null,
        forwardSubStoreRequest: async args => { calls.push(args); return new Response('download'); },
    };
    for (const [path, method] of [['/share/sub/demo', 'GET'], ['/share/sub/demo?token=u7.x', 'POST'], ['/share/sub/demo?token=u8.x', 'GET'], ['/share/sub/demo?token=u7.x&token=u7.y', 'GET'], ['/share/sub/demo/api/storage?token=u7.x', 'GET']]) {
        const response = await handleShareRequest({ request: new Request('https://example.test' + path, { method }), entryGateway });
        assert.equal(response.status, 404);
    }
    const response = await handleShareRequest({ request: new Request('https://example.test/share/sub/demo?token=u7.x'), entryGateway });
    assert.equal(await response.text(), 'download');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].preservePath, true);
    assert.equal(new URL(calls[0].request.url).pathname, '/share/sub/demo');
});

test('share route wrapper checks exact resource names, including encoded slashes', async () => {
    const old = globalThis.__substore_get_active_context__;
    globalThis.__substore_get_active_context__ = () => ({ user: { id: 7 } });
    try {
        const { api, data } = loadTokenApi();
        data.subs.push({ name: 'demo/other' });
        const token = api.createTokenItem({ type: 'sub', name: 'demo' }, { mode: 'count', count: 1 });
        const source = transformShareSupport(`function register($app) {
    // register routes
    registerDownloadRoutes($app);
    registerFileRoutes($app);
}`, '/restful/index.js');
        const handlers = new Map();
        let downloads = 0;
        const register = new Function('consumeShareToken', 'registerDownloadRoutes', 'registerFileRoutes', source + ';return register;')(
            api.consumeShareToken,
            app => app.get('/share/sub/:name', () => { downloads += 1; }),
            () => {},
        );
        register({ get: (path, callback) => handlers.set(path, callback) });
        const handle = handlers.get('/share/sub/:name');
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, end() {} };
        await handle({ path: '/share/sub/demo%2Fother', params: { name: 'demo/other' }, query: { token: token.token } }, res);
        assert.equal(res.statusCode, 404);
        assert.equal(downloads, 0);
        assert.equal(data.tokens[0].usedCount, 0);
        await handle({ path: '/share/sub/demo', params: { name: 'demo' }, query: { token: token.token } }, res);
        assert.equal(downloads, 1);
        await handle({ path: '/share/sub/demo', params: { name: 'demo' }, query: { token: token.token } }, res);
        assert.equal(downloads, 1);
    } finally { globalThis.__substore_get_active_context__ = old; }
});
