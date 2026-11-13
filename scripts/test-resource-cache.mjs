import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import { subStoreTransformPlugin } from '../vite.substore-transform.js';

test('upstream caches use each request snapshot and persist independently', () => {
    const previous = globalThis.__substore_get_active_context__;
    let current;
    globalThis.__substore_get_active_context__ = () => current;
    const storeA = new Map();
    const storeB = new Map();
    const contextA = { store: storeA };
    const contextB = { store: storeB };
    const $ = {
        read: key => current.store.get(key) ?? null,
        write: (value, key) => { current.store.set(key, value); },
        error: () => {},
    };
    const names = ['resource-cache', 'script-resource-cache', 'headers-resource-cache'];
    const keys = ['RESOURCE_CACHE_KEY', 'SCRIPT_RESOURCE_CACHE_KEY', 'HEADERS_RESOURCE_CACHE_KEY'];
    try {
        for (let i = 0; i < names.length; i++) {
            const filename = new URL(`../sub-store/backend/src/utils/${names[i]}.js`, import.meta.url);
            const source = readFileSync(filename, 'utf8');
            const plugin = subStoreTransformPlugin();
            let code = plugin.transform.call({ error(message) { throw new Error(message); } }, source, filename.pathname).code;
            const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
            for (const node of [...ast.body].reverse()) {
                if (node.type === 'ImportDeclaration') code = code.slice(0, node.start) + code.slice(node.end);
                if (node.type === 'ExportDefaultDeclaration') {
                    code = code.slice(0, node.start) + `const instance = ${code.slice(node.declaration.start, node.declaration.end)};` + code.slice(node.end);
                }
            }
            const key = `#test-${names[i]}`;
            const create = new Function('$', keys[i], 'SETTINGS_KEY', `DEFAULT_${i === 0 ? '' : i === 1 ? 'SCRIPT_' : 'HEADERS_'}CACHE_TTL`, code + '\nreturn instance;');
            current = undefined;
            const cache = create($, key, 'settings', 60000);
            assert.equal(storeA.size, i);
            assert.equal(storeB.size, i);
            storeA.set(key, JSON.stringify({
                expired: { time: Date.now() - 1000, data: 'stale' },
                existing: { time: Date.now() + 60000, data: 'preserved' },
            }));
            current = contextA;
            assert.equal(cache.get('expired'), null);
            assert.equal(JSON.parse(storeA.get(key)).expired, undefined);
            assert.equal(JSON.parse(storeA.get(key)).existing.data, 'preserved');
            cache.set('shared', `private-A-${i}`, 60000);
            current = contextB;
            assert.equal(cache.get('shared'), null);
            cache.set('shared', `private-B-${i}`, 60000);
            current = contextA;
            assert.equal(cache.get('shared'), `private-A-${i}`);
            current = contextB;
            cache.revokeAll();
            current = { store: storeA };
            assert.equal(cache.get('shared'), `private-A-${i}`);
            assert.equal(JSON.parse(storeA.get(key)).shared.data, `private-A-${i}`);
            assert.deepEqual(JSON.parse(storeB.get(key)), {});
            current = contextA;
        }
    } finally {
        globalThis.__substore_get_active_context__ = previous;
    }
});
