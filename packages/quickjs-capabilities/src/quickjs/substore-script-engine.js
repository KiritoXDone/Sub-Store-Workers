import {createHostCapabilities,installGuestCapabilities} from '../../install.mjs';
import {createPrimitives as createExtras} from '../../host/primitives.mjs';
/**
 * Sub-Store user script execution via QuickJS (WASM)
 *
 * Goal: Provide a Workers-safe replacement for upstream `new Function(...)` user scripts,
 * while keeping the script API surface as compatible as possible.
 */

import { debug, warn } from '../logger.js';
import { createQuickJsHostBridge, nativeToQuickJsHandle } from './quickjs-host-bridge.js';
import { SUBSTORE_PRELUDE } from './substore-prelude.js';

let quickJsModuleLoaderPromise = null;

async function getQuickJsModule() {
    if (!quickJsModuleLoaderPromise) {
        quickJsModuleLoaderPromise = import('./loader.js').then((mod) => mod.getQuickJsModule());
    }
    return await quickJsModuleLoaderPromise;
}

const GLOBAL_CREATE_DYNAMIC_FUNCTION = '__substore_workers_createDynamicFunction__';

const DEFAULT_LIMITS = {
    timeoutMs: 15000,
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 512 * 1024,
};

function declaresNamedFunction(source, fnName) {
    const s = String(source || '');
    // Basic heuristic: if user already provides a full function definition, don't rewrite.
    return new RegExp(`\\basync\\s+function\\s+${fnName}\\b|\\bfunction\\s+${fnName}\\b`).test(s);
}

function looksLikeShortcutScript(source) {
    const s = String(source || '');
    // Shortcut scripts in Sub-Store commonly rely on these injected identifiers.
    return s.includes('$server') || s.includes('$content') || s.includes('$files')
        || /\b(?:async\s+)?function\s+main\b|\b(?:const|let|var)\s+main\s*=/.test(s);
}

function wrapSubStoreShortcutScript(name, script) {
    // Mirror upstream fallback wrappers (processors/index.js ScriptFilter.nodeFunc / ScriptOperator.nodeFunc)
    if (name === 'filter') {
        return `async function filter(input = [], targetPlatform, context) {
            let proxies = input
            let list = []
            const fn = async ($server) => {
                ${script}
            }
            for await (let $server of proxies) {
                list.push(await fn($server))
            }
            return list
        }`;
    }

    if (name === 'operator') {
        return `async function operator(input = [], targetPlatform, context) {
            if (input && (input.$files || input.$content)) {
                let { $content, $files, $options, $file } = input
                if (['mihomoConfig', 'mihomoProfile'].includes($file?.type)) {
                    ${script}
                    if(typeof main === 'function') {
                        let config;
                        if ($content) {
                            try {
                                config = ProxyUtils.yaml.safeLoad($content);
                            } catch (e) {
                                console.log(e.message ?? e);
                            }
                        }
                        $content = ProxyUtils.yaml.safeDump(await main(config || {}))
                    }
                } else {
                    ${script}
                }
                return { $content, $files, $options, $file }
            } else {
                let proxies = input
                let list = []
                for await (let $server of proxies) {
                    ${script}
                    list.push($server)
                }
                return list
            }
        }`;
    }

    return script;
}

export function normalizeSubStoreScriptForQuickJs(name, script) {
    // Sub-Store officially supports "shortcut script" for Script Filter/Operator.
    // Example: `return $server._geo && $server._entrance` (no function declaration)
    // Upstream runs a fallback wrapper that defines `$server` per proxy.
    if ((name === 'filter' || name === 'operator') && !declaresNamedFunction(script, name) && looksLikeShortcutScript(script)) {
        return wrapSubStoreShortcutScript(name, script);
    }
    return script;
}

function isSafePathSegment(seg) {
    if (!seg) return false;
    if (seg === '__proto__' || seg === 'prototype' || seg === 'constructor') return false;
    // Avoid Function.prototype escape hatches for callable roots.
    if (seg === 'apply' || seg === 'call' || seg === 'bind') return false;
    return true;
}

function resolveCallable(rootMap, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) throw new Error('empty path');

    const rootName = parts[0];
    if (!Object.prototype.hasOwnProperty.call(rootMap, rootName)) {
        throw new Error(`host api root not allowed: ${rootName}`);
    }

    let receiver = undefined;
    let cur = rootMap[rootName];
    for (const seg of parts.slice(1)) {
        if (!isSafePathSegment(seg)) throw new Error(`unsafe property access: ${seg}`);
        receiver = cur;
        cur = cur?.[seg];
    }

    // lodash.mixin mutates its receiver, including the shared lodash module.
    // Reject the function itself so aliases under another host root cannot bypass the guard.
    if (typeof rootMap.lodash?.mixin === 'function' && cur === rootMap.lodash.mixin) {
        throw new Error('host api not allowed: lodash.mixin');
    }
    return { fn: cur, receiver };
}

function buildEnvSnapshot($substore) {
    const env = $substore?.env && typeof $substore.env === 'object' ? $substore.env : {};
    const snapshot = {
        isSurge: !!env.isSurge,
        isLoon: !!env.isLoon,
        isQuanX: !!env.isQuanX,
        isNode: !!env.isNode,
        isStash: !!env.isStash,
        isShadowrocket: !!env.isShadowrocket,
        isVercel: !!env.isVercel,
    };
    return snapshot;
}

export async function runScriptOnce({ name, script, $arguments, $options, $substore, hostRoots, callArgs, limits, quickjsModule, capabilityOptions = {} }) {
    const QuickJS = quickjsModule || await getQuickJsModule();
    const runtime = QuickJS.newRuntime();
    const owned = [];
    let vm;
    let bridge;
    let wakeup;
    let notified = false;
    const own = (handle) => { owned.push(handle); return handle; };
    const wake = () => {
        notified = true;
        if (wakeup) wakeup();
    };

    try {
        const deadline = Date.now() + limits.timeoutMs;
        runtime.setMemoryLimit(limits.memoryLimitBytes);
        runtime.setMaxStackSize(limits.maxStackSizeBytes);
        runtime.setInterruptHandler(() => Date.now() >= deadline);
        vm = runtime.newContext();
        bridge = createQuickJsHostBridge(vm, wake);
        const capabilities = createHostCapabilities(bridge.signal, capabilityOptions);
        const roots = { ...hostRoots, textCodec: bridge.textCodec, extras: createExtras(bridge.signal), web: capabilities.web, cryptoApi: capabilities.cryptoApi };

        const expose = (object, name, handle) => {
            own(handle);
            vm.setProp(object, name, handle);
            handle.dispose();
        };
        const unwrap = (result, label) => {
            if (!result.error) return own(result.value);
            try {
                const error = vm.dump(result.error);
                throw new Error(`${label}: ${error?.message || error}`);
            } finally {
                result.error.dispose();
            }
        };
        const invokeHost = (path, args, errorAsObject = false, links) => {
            path = String(path || '');
            const callable = resolveCallable(roots, path);
            if (typeof callable.fn !== 'function') throw new Error(`host api is not callable: ${String(path)}`);
            if (path.startsWith('substore.http.')) {
                const options = typeof args[0] === 'string' ? { url: args[0] } : { ...args[0] };
                args = [{ ...options, signal: bridge.signal }, ...args.slice(1)];
            }
            return bridge.bridgeResult(callable.fn.apply(callable.receiver, args), errorAsObject || /^(web|cryptoApi|extras)\./.test(path), links);
        };

        expose(vm.global, '__hostCall', vm.newFunction('__hostCall', (path, args) => {
            const call = bridge.openCall(args);
            try {
                return invokeHost(vm.dump(path), Array.isArray(call.value) ? call.value : [call.value], false, call.links);
            } finally { call.close(); }
        }));
        unwrap(vm.evalCode(SUBSTORE_PRELUDE), 'QuickJS prelude failed').dispose();
        installGuestCapabilities(vm, runtime, capabilityOptions);

        const qjsArguments = own(nativeToQuickJsHandle(vm, $arguments || {}));
        const qjsOptions = own(nativeToQuickJsHandle(vm, $options || {}));
        const qjsSubstore = own(vm.newObject());
        expose(qjsSubstore, 'env', nativeToQuickJsHandle(vm, buildEnvSnapshot($substore)));

        const qjsHttp = own(vm.newObject());
        for (const method of ['get', 'post', 'put', 'delete', 'head', 'options', 'patch']) {
            expose(qjsHttp, method, vm.newFunction(method, (options) =>
                invokeHost(`substore.http.${method}`, [bridge.toNative(options)], true)));
        }
        vm.setProp(qjsSubstore, 'http', qjsHttp);

        for (const method of ['read', 'write', 'delete', 'log', 'info', 'error', 'notify', 'wait']) {
            expose(qjsSubstore, method, vm.newFunction(method, (...args) =>
                invokeHost(`substore.${method}`, args.map((arg) => bridge.toNative(arg)))));
        }

        const consoleObj = own(vm.newObject());
        for (const level of ['log', 'info', 'warn', 'error']) {
            expose(consoleObj, level, vm.newFunction(level, (...args) => {
                try {
                    const nativeArgs = args.map((arg) => bridge.toNative(arg));
                    const sub = roots.substore;
                    const target = typeof sub?.[level] === 'function' ? sub[level] : console[level] || console.log;
                    if (typeof sub?.[level] === 'function') target.apply(sub, nativeArgs);
                    else target(...nativeArgs);
                } catch { /* logging must not fail the script */ }
                return vm.undefined;
            }));
        }
        vm.setProp(vm.global, 'console', consoleObj);

        const utilsObj = own(vm.newObject());
        for (const method of ['geoip', 'ipasn', 'ipaso']) {
            expose(utilsObj, method, vm.newFunction(method, (ip) => {
                const callable = resolveCallable(roots, `surgeUtils.${method}`);
                if (typeof callable.fn !== 'function') return vm.undefined;
                return bridge.bridgeResult(callable.fn.apply(callable.receiver, [bridge.toNative(ip)]));
            }));
        }
        vm.setProp(vm.global, '$utils', utilsObj);

        const makeHostProxy = own(vm.getProp(vm.global, '__makeHostProxy__'));
        const bufferPolyfill = own(vm.getProp(vm.global, '__sandboxBuffer__'));
        const mkProxy = (path) => {
            const pathHandle = own(vm.newString(path));
            try { return unwrap(vm.callFunction(makeHostProxy, vm.undefined, pathHandle), 'QuickJS proxy failed'); }
            finally { pathHandle.dispose(); }
        };
        const proxies = [
            'lodash', 'ProxyUtils', 'ProxyUtils.yaml', 'ProxyUtils.Base64.decode',
            'ProxyUtils.Base64.encode', 'DOMAIN_RESOLVERS', 'scriptResourceCache',
            'flowUtils', 'produceArtifact',
        ].map(mkProxy);
        const wrapperSource = `
(function($arguments,$options,$substore,lodash,ProxyUtils,yaml,Buffer,b64d,b64e,DOMAIN_RESOLVERS,scriptResourceCache,flowUtils,produceArtifact,require){
${script}\n
return ${name};
})
`;
        const wrapper = unwrap(vm.evalCode(wrapperSource), 'QuickJS compile failed');
        const fn = unwrap(vm.callFunction(
            wrapper, vm.undefined, qjsArguments, qjsOptions, qjsSubstore,
            own(vm.getProp(vm.global, '__sandboxLodash__')), proxies[1], proxies[2], bufferPolyfill, ...proxies.slice(3), own(vm.getProp(vm.global, 'require')),
        ), 'QuickJS script setup failed');
        const qjsCallArgs = callArgs.map((arg) => own(nativeToQuickJsHandle(vm, arg)));
        const result = unwrap(vm.callFunction(fn, vm.undefined, ...qjsCallArgs), 'QuickJS script threw');
        for (const arg of qjsCallArgs) arg.dispose();

        // Wake only when a host promise settles, with one timer for the remaining deadline.
        const waitForHost = async () => {
            if (notified) { notified = false; return; }
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('QuickJS promise pending timeout');
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, remaining);
                wakeup = () => { clearTimeout(timer); resolve(); };
            });
            wakeup = undefined;
            notified = false;
        };

        while (true) {
            if (bridge.getFailure()) throw bridge.getFailure();
            const state = vm.getPromiseState(result);
            if (state.type === 'rejected') {
                try {
                    const error = vm.dump(state.error);
                    throw new Error(`QuickJS promise rejected: ${error?.message || error}`);
                } finally { state.error.dispose(); }
            }
            if (state.type !== 'pending') {
                const finalHandle = state.notAPromise || state.value === result ? result : own(state.value);
                return bridge.toNative(finalHandle);
            }
            if (Date.now() >= deadline) throw new Error('QuickJS promise pending timeout');
            if (runtime.hasPendingJob()) {
                const jobs = runtime.executePendingJobs();
                if (jobs.error) {
                    try {
                        const error = vm.dump(jobs.error);
                        throw new Error(`QuickJS executePendingJobs error: ${error?.message || error}`);
                    } finally { jobs.error.dispose(); }
                }
            } else {
                await waitForHost();
            }
        }
    } finally {
        try { bridge?.close(); } catch (error) { warn('[QuickJS] bridge cleanup error:', error?.message || error); }
        for (let i = owned.length - 1; i >= 0; i--) {
            try { if (owned[i].alive) owned[i].dispose(); }
            catch (error) { warn('[QuickJS] handle cleanup error:', error?.message || error); }
        }
        try { if (vm?.alive) vm.dispose(); }
        catch (error) { warn('[QuickJS] context cleanup error:', error?.message || error); }
        try { if (runtime.alive) runtime.dispose(); }
        catch (error) { warn('[QuickJS] runtime cleanup error:', error?.message || error); }
    }
}

export function ensureSubStoreQuickJsScriptEngineInstalled({
    timeoutMs,
    memoryLimitBytes,
    maxStackSizeBytes,
} = {}) {
    if (typeof globalThis[GLOBAL_CREATE_DYNAMIC_FUNCTION] === 'function') return;

    globalThis[GLOBAL_CREATE_DYNAMIC_FUNCTION] = ({
        name,
        script,
        $arguments,
        $options,
        $substore,
        lodash,
        ProxyUtils,
        DOMAIN_RESOLVERS,
        scriptResourceCache,
        flowUtils,
        produceArtifact,
    }) => {
        const normalizedScript = normalizeSubStoreScriptForQuickJs(name, script);

        // Debug trace: whether Script Filter/Operator reached QuickJS.
        // This is intentionally lightweight and only logs when DEBUG=true.
        const requestId = globalThis.__substore_get_active_context__?.()?.requestId || 'unknown';
        if (name === 'filter' || name === 'operator') {
            const mode = normalizedScript !== script ? 'shortcut' : 'function';
            debug(`[SubStoreScript] [${requestId}] compile ${name} (${mode})`);
        }

        const limits = {
            timeoutMs: timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
            memoryLimitBytes: memoryLimitBytes ?? DEFAULT_LIMITS.memoryLimitBytes,
            maxStackSizeBytes: maxStackSizeBytes ?? DEFAULT_LIMITS.maxStackSizeBytes,
        };

        const hostRoots = {
            // callable via __hostCall('substore.read', [...])
            substore: $substore,
            surgeUtils: globalThis.$utils,
            lodash,
            ProxyUtils,
            DOMAIN_RESOLVERS,
            scriptResourceCache,
            flowUtils,
            // function
            produceArtifact: (...args) => produceArtifact(...args),
        };

        // Return a function compatible with upstream createDynamicFunction() output.
        return async (input = [], targetPlatform, context) => {
            const requestId2 = globalThis.__substore_get_active_context__?.()?.requestId || 'unknown';
            if (name === 'filter' || name === 'operator') {
                const inputHint = Array.isArray(input) ? `list(${input.length})` : 'artifact';
                debug(`[SubStoreScript] [${requestId2}] run ${name} ${inputHint}`);
            }
            return await runScriptOnce({
                name,
                script: normalizedScript,
                $arguments,
                $options,
                $substore,
                hostRoots,
                callArgs: [input, targetPlatform, context],
                limits,
            });
        };
    };
}
