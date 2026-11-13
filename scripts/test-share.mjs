import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import { transformShareSupport } from './substore-share-transform.mjs';

function loadTokenApi() {
    let source = transformShareSupport(readFileSync(new URL('../sub-store/backend/src/restful/token.js', import.meta.url), 'utf8'), '/restful/token.js');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of [...ast.body].reverse()) {
        if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration') source = source.slice(0, node.start) + source.slice(node.end);
        else if (node.type === 'ExportDefaultDeclaration') source = source.slice(0, node.start) + source.slice(node.declaration.start);
    }
    source = source.replace('const nanoid = eval(`require("nanoid")`);', 'const nanoid = {};');
    const data = { tokens: [], subs: [{ name: 'demo' }, { name: 'demo/other' }], files: [], collections: [] };
    const $ = { read: key => data[key], write: (value, key) => { data[key] = value; } };
    const names = ['$', 'TOKENS_KEY', 'SUBS_KEY', 'FILES_KEY', 'COLLECTIONS_KEY', 'RequestInvalidError', 'ResourceNotFoundError', 'insertByPosition', 'getCreateItemPosition', 'normalizeAgePublicKeyConfig'];
    const api = new Function(...names, source + '\nreturn {createTokenItem, consumeShareToken, deleteTokenItem};')($, 'tokens', 'subs', 'files', 'collections', Error, Error, (items, item) => items.push(item), () => 'bottom', () => {});
    return { api, data };
}

test('single-store sharing keeps exact token, resource, expiry and count validation', async () => {
    const { api, data } = loadTokenApi();
    const token = api.createTokenItem({ type: 'sub', name: 'demo' }, { mode: 'count', count: 1 });
    assert.match(token.token, /^[a-f0-9]{32}$/);
    const prefixed = api.createTokenItem({ type: 'sub', name: 'demo', token: 'u7.persisted' });
    const unprefixed = api.createTokenItem({ type: 'sub', name: 'demo', token: 'ordinary' });
    assert.equal(prefixed.token, 'u7.persisted');
    assert.equal(api.consumeShareToken({ token: prefixed.token, type: 'sub', name: 'demo' }).token, prefixed.token);
    assert.equal(api.consumeShareToken({ token: unprefixed.token, type: 'sub', name: 'demo' }).token, unprefixed.token);

    const source = transformShareSupport(`function register($app) {
    // register routes
    registerDownloadRoutes($app);
    registerFileRoutes($app);
}`, '/restful/index.js');
    const handlers = new Map();
    let downloads = 0;
    const register = new Function('consumeShareToken', 'registerDownloadRoutes', 'registerFileRoutes', source + ';return register;')(
        api.consumeShareToken, app => app.get('/share/sub/:name', () => { downloads += 1; }), () => {},
    );
    register({ get: (path, callback) => handlers.set(path, callback) });
    const handle = handlers.get('/share/sub/:name');
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, end() {} };
    await handle({ params: { name: 'demo/other' }, query: { token: token.token } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(data.tokens.find(item => item.token === token.token).usedCount, 0);
    await handle({ params: { name: 'demo' }, query: { token: token.token } }, res);
    await handle({ params: { name: 'demo' }, query: { token: token.token } }, res);
    assert.equal(downloads, 1);
    api.deleteTokenItem(prefixed.token, 'sub', 'demo');
    assert.equal(api.consumeShareToken({ token: prefixed.token, type: 'sub', name: 'demo' }), null);
    data.tokens.find(item => item.token === unprefixed.token).exp = Date.now() - 1;
    assert.equal(api.consumeShareToken({ token: unprefixed.token, type: 'sub', name: 'demo' }), null);
});

test('share feature exposes the configured single-store secret path', () => {
    const source = transformShareSupport(readFileSync(new URL('../sub-store/backend/src/restful/miscs.js', import.meta.url), 'utf8'), '/restful/miscs.js');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id?.name === 'getEnv');
    const getEnv = new Function('baseEnv', source.slice(node.start, node.end) + ';return getEnv;')({ feature: {}, meta: {} });
    const old = globalThis.__substore_get_active_context__;
    globalThis.__substore_get_active_context__ = () => ({ env: { SUB_STORE_FRONTEND_BACKEND_PATH: ' /only-secret/ ' } });
    try {
        let response;
        const res = { set() { return this; }, send(data) { response = JSON.parse(data); } };
        getEnv({ query: {} }, res);
        assert.equal(response.data.feature.share, true);
        assert.equal(response.data.meta.node.env.SUB_STORE_FRONTEND_BACKEND_PATH, '/only-secret');
    } finally { globalThis.__substore_get_active_context__ = old; }
});
