import path from 'node:path';
import { Buffer } from 'node:buffer';
import streamPromises from 'node:stream/promises';
import { createHttpClient } from '../http-client.js';
import { ensureSubStoreQuickJsScriptEngineInstalled } from '../quickjs/substore-script-engine.js';
import { ensureSurgeGeoipInstalled } from '../geoip/install.js';
import { createNotificationGateway } from '../notifications.js';
import { installSubStoreRuntimeGlobals } from './context.js';

export async function prepareSubStoreRuntime({ env, state, requestId }) {
    globalThis.Buffer = Buffer;
    globalThis.__path_shim__ = path;
    globalThis.__stream_promises_shim__ = streamPromises;
    if (!globalThis.process) {
        globalThis.process = { env: {}, version: 'v20.0.0', argv: [], cwd: () => '/' };
    }
    if (!globalThis.__fs_shim__) {
        globalThis.__fs_shim__ = { existsSync: () => false, readFileSync: () => '', writeFileSync: () => {}, copyFileSync: () => {} };
    }
    if (!globalThis.__ms_shim__) {
        globalThis.__ms_shim__ = (value) => {
            if (typeof value === 'number') return value;
            const match = String(value).match(/^(\d+)(ms|s|m|h|d|w|y)?$/);
            if (!match) return 0;
            const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
            return parseInt(match[1], 10) * multipliers[match[2] || 'ms'];
        };
    }
    installSubStoreRuntimeGlobals();
    globalThis.$httpClient = createHttpClient();
    ensureSubStoreQuickJsScriptEngineInstalled({ debug: env?.DEBUG === 'true' || env?.DEBUG === true });
    await ensureSurgeGeoipInstalled(env, { requestId });

    const lifetime = state?.waitUntil ? { waitUntil: (task) => state.waitUntil(task) } : undefined;
    return {
        notification: createNotificationGateway(env?.SUB_STORE_PUSH_SERVICE, lifetime),
        environment: { language: 'zh-Hans' },
    };
}

export function createSubStoreStorage(data, onWrite) {
    let store;
    try { store = JSON.parse(data || '{}'); }
    catch { throw new Error('Invalid Sub-Store data'); }
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('Invalid Sub-Store data');
    return {
        read(key) {
            const value = store[key || '__default__'];
            if (value === undefined || value === null) return null;
            return typeof value === 'object' ? JSON.stringify(value) : String(value);
        },
        write(value, key) {
            store[key || '__default__'] = value;
            onWrite(store);
            return true;
        },
    };
}

export function readSubStoreCache(storage) {
    let cache;
    try { cache = JSON.parse(storage.read('sub-store') || '{}'); }
    catch { throw new Error('Invalid Sub-Store cache'); }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('Invalid Sub-Store cache');
    return cache;
}
