import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ensureSubStoreQuickJsScriptEngineInstalled } from '../src/quickjs/substore-script-engine.js';

const { newQuickJSWASMModuleFromVariant } = await import(process.env.QUICKJS_TEST_CORE || 'quickjs-emscripten-core');
const { default: variant } = await import(process.env.QUICKJS_TEST_VARIANT || '@jitl/quickjs-wasmfile-release-sync');
const quickjs = await newQuickJSWASMModuleFromVariant(variant);
const runtimes = [];
globalThis.__loadQuickJsModule__ = async () => ({
    newRuntime() {
        const runtime = quickjs.newRuntime();
        runtimes.push(runtime);
        return runtime;
    },
});
ensureSubStoreQuickJsScriptEngineInstalled({ timeoutMs: 200 });
const factory = globalThis.__substore_workers_createDynamicFunction__;
const makeOperator = (script, overrides = {}) => factory({
    name: 'operator',
    script,
    $substore: { env: {} },
    ...overrides,
});
const runtimeClosed = () => assert.equal(runtimes.at(-1).alive, false);

test('releases the runtime on compile, execution and timeout failures', async () => {
    for (const script of [
        'function operator( {',
        'function operator() { throw new Error("script error") }',
        'async function operator() { return new Promise(() => {}) }',
    ]) {
        await assert.rejects(makeOperator(script)([]));
        runtimeClosed();
    }
    const badArguments = {};
    Object.defineProperty(badArguments, 'bad', { enumerable: true, get() { throw new Error('input conversion error'); } });
    await assert.rejects(makeOperator('function operator() {}', { $arguments: badArguments })([]), /input conversion error/);
    runtimeClosed();
});

test('bridges lodash callbacks and preserves callback errors', async () => {
    const lodash = {
        map: (values, iteratee) => values.map(iteratee),
        applyNested: (values, iteratees) => values.map(iteratees[0]),
    };
    const script = 'function operator(input) { return [lodash.map(input, p => p.name + $arguments.suffix), lodash.applyNested(input, [p => p.name])] }';
    assert.deepEqual(await makeOperator(script, { lodash, $arguments: { suffix: '!' } })([{ name: 'a' }, { name: 'b' }]), [['a!', 'b!'], ['a', 'b']]);
    const mutating = 'function operator(input) { const result = lodash.map(input, p => { p.name += "!"; return p; }); return [input[0].name, result[0] === input[0]]; }';
    assert.deepEqual(await makeOperator(mutating, { lodash })([{ name: 'a' }]), ['a!', true]);
    runtimeClosed();
    await assert.rejects(makeOperator('function operator() { return lodash.map([1], () => { throw new Error("callback error") }) }', { lodash })([]), /callback error/);
    runtimeClosed();
});

test('blocks shared lodash mixin through its name and host aliases', async () => {
    const requireBackend = createRequire(new URL('../sub-store/backend/package.json', import.meta.url));
    const lodash = requireBackend('lodash');
    const originalMap = lodash.map;
    const ProxyUtils = { alias: lodash.mixin };
    for (const call of [
        'lodash.mixin({ map: () => ["altered"] })',
        'ProxyUtils.alias({ map: () => ["altered"] })',
        '__hostCall("lodash.mixin", [{ map: () => ["altered"] }])',
    ]) {
        await assert.rejects(makeOperator(`function operator() { ${call} }`, { lodash, ProxyUtils })([]), /host api not allowed: lodash\.mixin/);
        assert.equal(lodash.map, originalMap);
        assert.deepEqual(lodash.map([1], value => value + 1), [2]);
        runtimeClosed();
    }
});

test('round trips UTF-8 and binary data including typed-array offsets', async () => {
    const body = new Uint8Array([0, 0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87, 0]).buffer;
    const lodash = { echo: (value) => value };
    const $substore = { env: {}, http: { get: async () => ({ body }) } };
    const script = `async function operator() {
        const response = await $substore.http.get('https://example.invalid');
        const part = new Uint8Array(response.body, 1, 6);
        const echo = lodash.echo({ bytes: part });
        return [Buffer.from(part).toString(), Buffer.from(echo.bytes).toString('base64'),
            Buffer.from([0, 255, 16]).toString('hex'), new TextDecoder().decode(new TextEncoder().encode('😀'))];
    }`;
    assert.deepEqual(await makeOperator(script, { $substore, lodash })([]), ['中文', '5Lit5paH', '00ff10', '😀']);
    runtimeClosed();
});

test('aborts late host work and ignores its completion after disposal', async () => {
    let resolveLate;
    let rejectLate;
    let lateCallback;
    let signal;
    const $substore = { env: {}, http: { get(options) {
        signal = options.signal;
        return new Promise((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
    } } };
    assert.equal(await makeOperator("function operator() { $substore.http.get('https://example.invalid'); return 'done' }", { $substore })([]), 'done');
    assert.equal(signal.aborted, true);
    runtimeClosed();
    resolveLate({ body: 'late' });
    await Promise.resolve();
    await Promise.resolve();
    runtimeClosed();

    await assert.rejects(makeOperator("async function operator() { return await $substore.http.get('https://example.invalid') }", { $substore })([]), /timeout/);
    assert.equal(signal.aborted, true);
    runtimeClosed();
    rejectLate(new Error('late rejection'));
    await Promise.resolve();
    const lodash = { defer: (callback) => { lateCallback = callback; } };
    await makeOperator('function operator() { lodash.defer(() => { throw new Error("must not run") }); }', { lodash })([]);
    assert.equal(lateCallback(), undefined);
    runtimeClosed();
});

test('Mihomo shortcut accepts both file types and passes an empty config when needed', async () => {
    const ProxyUtils = { yaml: { safeLoad: JSON.parse, safeDump: JSON.stringify } };
    const script = 'function main(config) { config.test = true; return config; }';
    for (const type of ['mihomoConfig', 'mihomoProfile']) {
        const input = { $files: [], $content: '', $file: { type, sourceType: 'collection' } };
        const result = await makeOperator(script, { ProxyUtils, produceArtifact: () => { throw new Error('must not produce'); } })(input);
        assert.equal(result.$content, '{"test":true}');
        runtimeClosed();
    }
});
