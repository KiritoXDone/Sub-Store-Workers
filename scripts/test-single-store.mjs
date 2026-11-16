import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:3000';
const prefix = process.env.SUB_STORE_FRONTEND_BACKEND_PATH || '/local-test-backend';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Only run smoke tests against a local server');
const name = 'single-store-smoke-' + Date.now();
async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + path, {
        method, headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
}
function success(response) {
    assert.ok(response.status >= 200 && response.status < 300, response.text);
    assert.notEqual(response.data?.status, 'failed', response.text);
    return response.data?.data;
}
for (const path of ['/dashboard/', '/api/dashboard/auth/login', '/api/subs']) {
    assert.equal((await request(path)).status, 404);
}
const info = success(await request(prefix + '/api/utils/env'));
assert.equal(info.feature.share, true);
assert.equal(info.isWorker, true);
assert.equal(info.meta.node.env.SUB_STORE_FRONTEND_BACKEND_PATH, prefix);
success(await request(prefix + '/api/subs', {
    name, source: 'local', content: 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#node',
    process: [{ type: 'Script Operator', args: { mode: 'script', content: 'function operator(nodes){return lodash.map(nodes,n=>({...n,name:Buffer.from("单库").toString()+n.name}))}' } }],
}));
const downloaded = await request(prefix + '/download/' + name + '?target=JSON');
success(downloaded);
assert.match(downloaded.text, /单库node/);
const { token } = success(await request(prefix + '/api/token', { payload: { type: 'sub', name }, options: { mode: 'count', count: 1 } }));
assert.ok(!/^u\d+\./.test(token));
const share = '/share/sub/' + name + '?target=JSON&token=' + encodeURIComponent(token);
const first = await request(share);
success(first);
assert.match(first.text, /example.com/);
assert.equal((await request(share)).status, 404);
const collectionName = name + '-collection';
const fileName = name + '-file';
success(await request(prefix + '/api/collections', { name: collectionName, subscriptions: [name] }));
success(await request(prefix + '/api/files', { name: fileName, source: 'local', content: 'local file fixture' }));
for (const [type, resource, expected] of [
    ['col', collectionName, /example.com/],
    ['file', fileName, /local file fixture/],
]) {
    const shared = success(await request(prefix + '/api/token', { payload: { type, name: resource }, options: { mode: 'count', count: 1 } }));
    const url = `/share/${type}/${resource}?target=JSON&token=${encodeURIComponent(shared.token)}`;
    assert.equal((await request(url.replace(resource, resource + '-wrong'))).status, 404);
    const firstResponse = await request(url);
    success(firstResponse);
    assert.match(firstResponse.text, expected);
    assert.equal((await request(url)).status, 404);
}
const backup = await request(prefix + '/api/storage');
success(backup);
assert.match(backup.text, new RegExp(name));
const restoredName = name + '-restored';
const restored = structuredClone(backup.data);
delete restored.schemaVersion;
restored.subs.push({ name: restoredName, source: 'local', content: 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#restored' });
success(await request(prefix + '/api/storage', { content: JSON.stringify(restored) }));
const restoredDownload = await request(prefix + '/download/' + restoredName + '?target=JSON');
success(restoredDownload);
assert.match(restoredDownload.text, /restored/);
success(await request(prefix + '/api/sub/' + restoredName + '?mode=permanent', undefined, 'DELETE'));

success(await request(prefix + '/api/collection/' + collectionName + '?mode=permanent', undefined, 'DELETE'));
success(await request(prefix + '/api/file/' + fileName + '?mode=permanent', undefined, 'DELETE'));
success(await request(prefix + '/api/sub/' + name + '?mode=permanent', undefined, 'DELETE'));
console.log('PASS: private single store, scripted conversion, subscription/collection/file sharing, backup and restore');
