import { requestContext } from '../context.js';

const REGISTRY_KEY = '__substore_request_contexts__';
const PROXIES_INSTALLED_KEY = '__substore_context_proxies_installed__';
const RUNTIME_GLOBALS_INSTALLED_KEY = '__substore_runtime_globals_installed__';
const FALLBACK_ENV_KEY = '__substore_runtime_fallback_env__';
let importContext = null;

function getRegistry() {
    if (!globalThis[REGISTRY_KEY]) {
        globalThis[REGISTRY_KEY] = new Map();
    }
    return globalThis[REGISTRY_KEY];
}

export function getActiveSubStoreContext() {
    return requestContext.getStore()?.subStore || importContext;
}

export async function runWithSubStoreImportContext(fn) {
    const context = requestContext.getStore()?.subStore;
    if (!context) throw new Error('Sub-Store import requires an active request');
    if (importContext && importContext !== context) throw new Error('Sub-Store import already in progress');
    importContext = context;
    try {
        return await fn();
    } finally {
        if (importContext === context) importContext = null;
    }
}

export function getSubStoreContextById(requestId) {
    if (!requestId) return null;
    return getRegistry().get(requestId) || null;
}

function getActiveSubStoreEnv() {
    return getActiveSubStoreContext()?.env || globalThis[FALLBACK_ENV_KEY] || {};
}

function createEnvProxy() {
    return new Proxy({}, {
        get(_target, prop) {
            return getActiveSubStoreEnv()?.[prop];
        },
        set(_target, prop, value) {
            const env = getActiveSubStoreEnv();
            env[prop] = value;
            return true;
        },
        has(_target, prop) {
            return prop in (getActiveSubStoreEnv() || {});
        },
        ownKeys() {
            return Reflect.ownKeys(getActiveSubStoreEnv() || {});
        },
        getOwnPropertyDescriptor(_target, prop) {
            const env = getActiveSubStoreEnv() || {};
            if (!(prop in env)) return undefined;
            return { enumerable: true, configurable: true };
        },
    });
}

export function installSubStoreRuntimeGlobals() {
    if (globalThis[RUNTIME_GLOBALS_INSTALLED_KEY]) return;

    const existingProcess = globalThis.process && typeof globalThis.process === 'object' ? globalThis.process : {};
    globalThis[FALLBACK_ENV_KEY] = existingProcess.env || {};
    const envProxy = createEnvProxy();

    Object.defineProperty(globalThis, '__env__', {
        configurable: true,
        get: getActiveSubStoreEnv,
    });

    globalThis.process = {
        ...existingProcess,
        version: existingProcess.version || 'v20.0.0',
        argv: existingProcess.argv || [],
        cwd: existingProcess.cwd || (() => '/'),
    };
    Object.defineProperty(globalThis.process, 'env', {
        configurable: true,
        get() {
            return envProxy;
        },
    });

    globalThis.__filename = '/worker.js';
    globalThis.__dirname = '/';
    globalThis[RUNTIME_GLOBALS_INSTALLED_KEY] = true;
}

export function installSubStoreContextGlobals() {
    if (globalThis[PROXIES_INSTALLED_KEY]) return;

    globalThis.__substore_get_active_context__ = getActiveSubStoreContext;
    globalThis.__substore_get_context_by_id__ = getSubStoreContextById;

    Object.defineProperty(globalThis, '$request', {
        configurable: true,
        get() {
            return getActiveSubStoreContext()?.request;
        },
    });

    globalThis.$persistentStore = {
        read(key) {
            return getActiveSubStoreContext()?.persistentStore?.read(key) ?? null;
        },
        write(data, key) {
            return getActiveSubStoreContext()?.persistentStore?.write(data, key) ?? false;
        },
    };

    globalThis.$done = (response) => {
        const ctx = getActiveSubStoreContext();
        if (typeof ctx?.done === 'function') {
            ctx.done(response);
        }
    };

    globalThis.$notification = {
        post(...args) {
            return getActiveSubStoreContext()?.notification?.post?.(...args);
        },
    };

    globalThis.$environment = new Proxy({}, {
        get(_target, prop) {
            return getActiveSubStoreContext()?.environment?.[prop];
        },
        has(_target, prop) {
            return prop in (getActiveSubStoreContext()?.environment || {});
        },
        ownKeys() {
            return Reflect.ownKeys(getActiveSubStoreContext()?.environment || {});
        },
        getOwnPropertyDescriptor(_target, prop) {
            const environment = getActiveSubStoreContext()?.environment || {};
            if (!(prop in environment)) return undefined;
            return { enumerable: true, configurable: true };
        },
    });

    globalThis[PROXIES_INSTALLED_KEY] = true;
}

export function createSubStoreRequestContext({ requestId, request, env, persistentStore, notification, environment, cache = {} }) {
    return {
        requestId,
        request,
        env,
        persistentStore,
        notification,
        environment,
        cache,
        dirty: false,
        storeData: null,
        done: null,
    };
}

export async function runWithSubStoreContext(subStoreContext, fn) {
    installSubStoreContextGlobals();
    getRegistry().set(subStoreContext.requestId, subStoreContext);
    const parent = requestContext.getStore() || {};
    return await requestContext.run({ ...parent, subStore: subStoreContext }, fn);
}

export function flushSubStoreRequestContext(subStoreContext) {
    if (!subStoreContext?.dirty || !subStoreContext.storeData) return null;
    const dataString = JSON.stringify(subStoreContext.storeData);
    subStoreContext.dirty = false;
    subStoreContext.storeData = null;
    return dataString;
}

export function deleteSubStoreRequestContext(requestId) {
    if (!requestId) return;
    getRegistry().delete(requestId);
}
