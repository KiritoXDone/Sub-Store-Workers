import assert from 'node:assert/strict';
import test from 'node:test';
import { subStoreTransformPlugin } from '../vite.substore-transform.js';

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
    return new Function(result.code.replace('export class OpenAPI', 'class OpenAPI') + '\nreturn { isSurge, isNode };')();
}

for (const suffix of ['', ' && !isEgern']) {
    test(`Workers uses the Surge HTTP/persistence adapter${suffix ? ' with Egern detection' : ''}`, () => {
        assert.deepEqual(transformEnvironment(`typeof $httpClient !== 'undefined' && !isLoon${suffix}`), { isSurge: true, isNode: false });
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
