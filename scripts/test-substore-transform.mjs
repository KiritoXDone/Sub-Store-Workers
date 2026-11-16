import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import { subStoreTransformPlugin } from '../vite.substore-transform.js';
import { enableWorkerBranches, markWorkerBackend, markWorkerEnvironment } from './substore-environment-transform.mjs';

test('Worker identity is added without changing upstream platform flags', () => {
    const source = 'export function ENV() { return { isSurge: false, isNode: false }; }';
    const transformed = markWorkerEnvironment(source).replace('export function', 'function');
    assert.deepEqual(new Function(transformed + '; return ENV();')(), { isWorker: true, isSurge: false, isNode: false });
    assert.throws(() => markWorkerEnvironment('export function ENV() { return { isWorker: false }; }'), /requires review/);
});

test('Worker enters shared adapter branches without enabling Surge-only options', () => {
    const source = `
function shared(isSurge, isEgern, isWorker) { if (isSurge || isEgern) return 'adapter'; return 'none'; }
function surgeOnly(isSurge, isWorker) { if (isSurge) return 'policy'; return 'none'; }
`;
    const transformed = enableWorkerBranches(source, 'isWorker', 1);
    const api = new Function(transformed + '; return { shared, surgeOnly };')();
    assert.equal(api.shared(false, false, true), 'adapter');
    assert.equal(api.surgeOnly(false, true), 'none');
    assert.throws(() => enableWorkerBranches('if (isSurge && enabled) {}', 'isWorker'), /requires review/);
    assert.throws(() => enableWorkerBranches('if (isSurge || isVercel) {}', 'isWorker'), /requires review/);
    assert.equal(markWorkerBackend("let backend = 'Node';"), "let backend = 'Workers';");
});

test('upstream notifications and done use the Worker branch with Surge disabled', () => {
    const upstream = readFileSync(new URL('../sub-store/backend/src/vendor/open-api.js', import.meta.url), 'utf8');
    const source = enableWorkerBranches(upstream, 'isWorker', 9);
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const openApi = ast.body.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'OpenAPI')?.declaration;
    const methods = ['notify', 'done'].map((name) => openApi?.body.body.find((method) => method.key?.name === name));
    assert.ok(methods.every(Boolean));
    const calls = [];
    const WorkerOpenAPI = new Function('isQX', 'isLoon', 'isSurge', 'isEgern', 'isNode', 'isGUIforCores', 'isWorker', '$notification', '$done',
        `return class { ${methods.map((method) => source.slice(method.start, method.end)).join('\n')} };`)(
        false, false, false, false, false, false, true,
        { post: (...args) => calls.push(['notify', ...args]) }, (value) => calls.push(['done', value]),
    );
    const api = new WorkerOpenAPI();
    api.notify('title', 'subtitle', 'content');
    api.done({ body: 'result' });
    assert.deepEqual(calls, [
        ['notify', 'title', 'subtitle', 'content', { url: undefined }],
        ['done', { body: 'result' }],
    ]);
});

function transformEnvironment(surgeExpression) {
    const source = `
const isLoon = false;
const isEgern = false;
const isSurge = ${surgeExpression};
const isNode = eval(\`typeof process !== "undefined"\`);
export class OpenAPI {
    initCache() { this.cache = JSON.parse($persistentStore.read(this.name) || '{}'); }
    persistCache() { const data = JSON.stringify(this.cache, null, 2); return data; }
    write(data, key) { this.cache[key] = data; }
    read(key) { return this.cache[key]; }
    delete(key) { delete this.cache[key]; }
}
`;
    const plugin = subStoreTransformPlugin();
    const result = plugin.transform.call({ error(message) { throw new Error(message); } }, source, '/sub-store/backend/src/vendor/open-api.js');
    return new Function(result.code.replace('export class OpenAPI', 'class OpenAPI') + '\nreturn { isWorker, isSurge, isNode };')();
}

for (const suffix of ['', ' && !isEgern']) {
    test(`Workers uses its own HTTP/persistence branch${suffix ? ' with Egern detection' : ''}`, () => {
        assert.deepEqual(transformEnvironment(`typeof $httpClient !== 'undefined' && !isLoon${suffix}`), { isWorker: true, isSurge: false, isNode: false });
    });
}

test('an unsupported environment expression still fails the build guard', () => {
    assert.throws(() => transformEnvironment("typeof $httpClient !== 'undefined' && !isLoon && !unknownPlatform"), /isSurge/);
});

function transformSource(source, relativePath) {
    return subStoreTransformPlugin().transform.call({ error(message) { throw new Error(message); } }, source, `/sub-store/backend/src/${relativePath}`);
}

test('handwritten Trojan parsers keep their existing implementation', () => {
    const source = 'export default function getParser() { return { parse: input => input }; }';
    assert.equal(transformSource(source, 'core/proxy-utils/parsers/peggy/trojan-uri.js'), null);
});

test('Peggy grammars are compiled to parsers that run without peggy.generate', () => {
    const result = transformSource('import peggy from "peggy";\nconst grammars = String.raw`start = "trojan"`;', 'core/proxy-utils/parsers/peggy/example.js');
    const getParser = new Function(result.code.replace('export default function', 'function') + '\nreturn getParser;')();
    assert.equal(getParser().parse('trojan'), 'trojan');
    assert.throws(() => getParser().parse('invalid'));
    assert.ok(!result.code.includes('peggy.generate'));
});

test('a Peggy dependency without recognizable grammar still fails the build', () => {
    assert.throws(() => transformSource('import peggy from "peggy"; export default peggy;', 'core/proxy-utils/parsers/peggy/example.js'), /未找到 grammars/);
});

for (const expression of ["require('fs')", 'eval("require(\'fs\')")']) {
    test(`filesystem imports use the existing host shim: ${expression}`, () => {
        const result = transformSource(`export default function getFs() { return ${expression}; }`, 'runtime/fs.js');
        const shim = { existsSync: () => false };
        const run = new Function('globalThis', result.code.replace('export default function', 'function') + '\nreturn getFs();');
        assert.equal(run({ __fs_shim__: shim }), shim);
    });
}


test('script factory replacement preserves following upstream declarations', () => {
    const source = `
function createDynamicFunction(name, script, $arguments, $options) {
    const nested = () => ({ text: "}", template: \`value \${{ nested: true }.nested}\` });
    return nested;
}
export const afterFactory = 'preserved';
`;
    const result = transformSource(source, 'core/proxy-utils/processors/index.js');
    assert.ok(result.code.includes("export const afterFactory = 'preserved'"));
    assert.ok(result.code.includes('__SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__'));
    assert.ok(!result.code.includes('const nested'));
    assert.throws(() => transformSource('function createDynamicFunction(changed) {}', 'core/proxy-utils/processors/index.js'), /createDynamicFunction/);
});

test('restoring a backup replaces the request cache before migration and preserves data on failure', () => {
    const source = `
function HTTP(options) { const opts = JSON.parse(JSON.stringify(options)); }
const isSurge = true;
export class OpenAPI {
    initCache() { this.cache = JSON.parse($persistentStore.read(this.name) || '{}'); }
    persistCache() { const data = JSON.stringify(this.cache, null, 2); $persistentStore.write(data, 'sub-store'); }
    write(data, key) {
        if (key.indexOf('#') !== -1) { key = key.substr(1); return $persistentStore.write(data, key); }
        this.cache[key] = data;
        this.persistCache();
    }
    read(key) { return this.cache[key]; }
    delete(key) { delete this.cache[key]; }
}
`;
    const result = transformSource(source, 'vendor/open-api.js');
    const oldContext = globalThis.__substore_get_active_context__;
    const oldStore = globalThis.$persistentStore;
    const context = { cache: { schemaVersion: '2.0', subs: [{ name: 'old' }] } };
    let persisted = 'original';
    let writeResult = true;
    globalThis.__substore_get_active_context__ = () => context;
    globalThis.$persistentStore = {
        read: () => persisted,
        write: (data) => { if (writeResult) persisted = data; return writeResult; },
    };
    try {
        const OpenAPI = new Function(result.code.replace('export class OpenAPI', 'class OpenAPI') + '\nreturn OpenAPI;')();
        const api = new OpenAPI();
        const restored = { settings: {}, subs: [{ name: 'restored' }] };
        assert.equal(api.write(JSON.stringify(restored), '#sub-store'), true);
        assert.deepEqual(context.cache, restored);
        if (!api.read('schemaVersion')) api.write('2.0', 'schemaVersion');
        assert.deepEqual(JSON.parse(persisted), { ...restored, schemaVersion: '2.0' });
        assert.throws(() => api.write('{invalid', '#sub-store'));
        const before = persisted;
        const oldCache = context.cache;
        writeResult = false;
        assert.throws(() => api.write(JSON.stringify({ settings: {}, subs: [] }), '#sub-store'), /backup write failed/);
        assert.equal(persisted, before);
        assert.equal(context.cache, oldCache);
    } finally {
        globalThis.__substore_get_active_context__ = oldContext;
        globalThis.$persistentStore = oldStore;
    }
});
