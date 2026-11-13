function resultValue(vm, result, label) {
    if (!result.error) return result.value;
    try {
        const error = vm.dump(result.error);
        throw new Error(`${label}: ${error?.message || error}`);
    } finally {
        result.error.dispose();
    }
}

// Return a fresh owned handle. Temporary handles are released even on conversion errors.
export function nativeToQuickJsHandle(vm, value, links) {
    const seen = new Map();
    const convert = (item) => {
        if (item === null) return vm.null;
        if (item === undefined) return vm.undefined;
        if (typeof item === 'string') return vm.newString(item);
        if (typeof item === 'number') return vm.newNumber(item);
        if (typeof item === 'boolean') return item ? vm.true : vm.false;
        if (typeof item === 'bigint') return vm.newBigInt(item);
        if (typeof item !== 'object') return vm.newString(String(item));
        const linked = links?.get(item);
        if (linked?.alive) return linked.dup();
        if (seen.has(item)) return seen.get(item).dup();

        if (item instanceof ArrayBuffer) return vm.newArrayBuffer(item);
        if (ArrayBuffer.isView(item)) {
            const bytes = item.buffer.slice(item.byteOffset, item.byteOffset + item.byteLength);
            const buffer = vm.newArrayBuffer(bytes);
            let createView;
            let name;
            try {
                createView = vm.getProp(vm.global, '__bridgeMakeView__');
                name = vm.newString(item.constructor?.name === 'Buffer' ? 'Uint8Array' : item.constructor?.name || 'Uint8Array');
                return resultValue(vm, vm.callFunction(createView, vm.undefined, buffer, name), 'QuickJS binary conversion failed');
            } finally {
                name?.dispose();
                createView?.dispose();
                buffer.dispose();
            }
        }

        const handle = Array.isArray(item) ? vm.newArray() : vm.newObject();
        try {
            seen.set(item, handle.dup());
            if (Array.isArray(item)) {
                const length = vm.newNumber(item.length);
                try { vm.setProp(handle, 'length', length); } finally { length.dispose(); }
            }
            for (const [key, child] of Object.entries(item)) {
                const childHandle = convert(child);
                try {
                    if (key === '__proto__') {
                        const define = vm.getProp(vm.global, '__bridgeDefineProtoKey__');
                        try {
                            resultValue(vm, vm.callFunction(define, vm.undefined, handle, childHandle), 'QuickJS property conversion failed').dispose();
                        } finally { define.dispose(); }
                    } else {
                        vm.setProp(handle, key, childHandle);
                    }
                } finally {
                    childHandle.dispose();
                }
            }
            return handle;
        } catch (error) {
            handle.dispose();
            throw error;
        }
    };
    try {
        return convert(value);
    } finally {
        for (const handle of seen.values()) handle.dispose();
    }
}

export function createQuickJsHostBridge(vm, wake) {
    let active = true;
    let failure = null;
    const pending = new Set();
    const callbacks = new Set();
    const decoders = new Map();
    const abortController = new AbortController();
    let nextDecoderId = 1;

    const textCodec = {
        encode: (text) => new TextEncoder().encode(text),
        decodeUtf8: (bytes) => new TextDecoder().decode(bytes),
        createDecoder: (label, options) => {
            const decoder = new TextDecoder(label, options);
            const id = nextDecoderId++;
            decoders.set(id, decoder);
            return { id, encoding: decoder.encoding, fatal: decoder.fatal, ignoreBOM: decoder.ignoreBOM };
        },
        decode: (id, bytes, options) => {
            const decoder = decoders.get(id);
            if (!decoder) throw new Error('TextDecoder is no longer available');
            return decoder.decode(bytes, options);
        },
    };

    function callHelper(name, value) {
        const helper = vm.getProp(vm.global, name);
        try {
            return resultValue(vm, vm.callFunction(helper, vm.undefined, value), `QuickJS ${name} failed`);
        } finally {
            helper.dispose();
        }
    }

    function convertGuest(handle, state) {
        const kindHandle = callHelper('__bridgeKind__', handle);
        let kind;
        try { kind = vm.getString(kindHandle); } finally { kindHandle.dispose(); }
        if (kind === 'function') {
            const callback = handle.dup();
            callbacks.add(callback);
            return (...args) => {
                if (!active) return undefined;
                const handles = [];
                try {
                    for (const arg of args) handles.push(nativeToQuickJsHandle(vm, arg, state.links));
                    const result = resultValue(vm, vm.callFunction(callback, vm.undefined, ...handles), 'QuickJS callback failed');
                    try {
                        const promiseState = vm.getPromiseState(result);
                        if (!promiseState.notAPromise) {
                            if (promiseState.type === 'fulfilled') promiseState.value.dispose();
                            if (promiseState.type === 'rejected') promiseState.error.dispose();
                            throw new Error('Asynchronous callbacks passed to host functions are not supported');
                        }
                        return convertGuest(result, state);
                    } finally {
                        result.dispose();
                    }
                } finally {
                    for (const arg of handles) arg.dispose();
                }
            };
        }
        if (kind === 'buffer' || kind === 'view') {
            const buffer = callHelper('__bridgeBytes__', handle);
            try {
                const bytes = vm.getArrayBuffer(buffer);
                try {
                    const copy = Uint8Array.from(bytes.value);
                    return kind === 'buffer' ? copy.buffer : copy;
                } finally {
                    bytes.dispose();
                }
            } finally {
                buffer.dispose();
            }
        }
        if (kind !== 'object' && kind !== 'array') return vm.dump(handle);
        const idHandle = callHelper('__bridgeId__', handle);
        let id;
        try { id = vm.getNumber(idHandle); } finally { idHandle.dispose(); }
        if (state.seen.has(id)) return state.seen.get(id);
        const object = kind === 'array' ? new Array(vm.getLength(handle) || 0) : {};
        state.seen.set(id, object);
        if (state.open) {
            const link = handle.dup();
            state.links.set(object, link);
            state.handles.push(link);
        }
        const keys = resultValue(vm, vm.getOwnPropertyNames(handle, { strings: true, numbersAsStrings: true, onlyEnumerable: true }), 'QuickJS properties failed');
        try {
            for (const keyHandle of keys) {
                const key = vm.getString(keyHandle);
                const child = vm.getProp(handle, keyHandle);
                try {
                    Object.defineProperty(object, key, { value: convertGuest(child, state), writable: true, enumerable: true, configurable: true });
                } finally {
                    child.dispose();
                }
            }
        } finally {
            keys.dispose();
        }
        return object;
    }

    function openCall(handle) {
        const state = { seen: new Map(), links: new WeakMap(), handles: [], open: true };
        try {
            const special = callHelper('__bridgeNeedsConversion__', handle);
            let value;
            try {
                value = vm.dump(special) ? convertGuest(handle, state) : vm.dump(handle);
            } finally {
                special.dispose();
            }
            return {
                value,
                links: state.links,
                close() {
                    state.open = false;
                    for (const item of state.handles) if (item.alive) item.dispose();
                    state.handles.length = 0;
                },
            };
        } catch (error) {
            state.open = false;
            for (const item of state.handles) if (item.alive) item.dispose();
            throw error;
        }
    }

    function toNative(handle) {
        const call = openCall(handle);
        try { return call.value; } finally { call.close(); }
    }

    function bridgeResult(result, errorAsObject = false, links) {
        if (!result || (typeof result !== 'object' && typeof result !== 'function') || typeof result.then !== 'function') {
            return nativeToQuickJsHandle(vm, result, links);
        }
        const deferred = vm.newPromise();
        const entry = { deferred, result };
        pending.add(entry);
        const settle = (value, rejected) => {
            if (!active) return;
            try {
                let handle;
                try {
                    handle = rejected
                        ? (errorAsObject ? vm.newError(value?.message || String(value)) : vm.newString(value?.message || String(value)))
                        : nativeToQuickJsHandle(vm, value);
                    if (rejected) deferred.reject(handle);
                    else deferred.resolve(handle);
                } finally {
                    handle?.dispose();
                }
            } catch (error) {
                try {
                    const handle = vm.newError(error?.message || String(error));
                    try { deferred.reject(handle); } finally { handle.dispose(); }
                } catch (bridgeError) {
                    failure = bridgeError;
                }
            } finally {
                pending.delete(entry);
                try { if (deferred.alive) deferred.dispose(); }
                catch (error) { failure = error; }
                finally { wake(); }
            }
        };
        Promise.resolve(result).then((value) => settle(value, false), (error) => settle(error, true));
        return deferred.handle;
    }

    function close() {
        active = false;
        let failure;
        const attempt = (action) => {
            try { action(); } catch (error) { failure ||= error; }
        };
        attempt(() => abortController.abort());
        for (const { deferred, result } of pending) {
            if (typeof result.cancel === 'function') attempt(() => result.cancel());
            attempt(() => { if (deferred.alive) deferred.dispose(); });
        }
        pending.clear();
        for (const handle of callbacks) attempt(() => { if (handle.alive) handle.dispose(); });
        callbacks.clear();
        decoders.clear();
        if (failure) throw failure;
    }

    return { textCodec, toNative, openCall, bridgeResult, close, signal: abortController.signal, getFailure: () => failure };
}
