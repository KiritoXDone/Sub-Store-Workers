export function createResources(signal, { maxHandles = 4096 } = {}) {
    let next = 0, closed = false;
    const entries = new Map(), ids = new WeakMap();
    function put(type, value, cleanup) {
        if (closed) throw new Error('Script execution has ended');
        if (value && typeof value === 'object' && ids.has(value)) return ids.get(value);
        if (entries.size >= maxHandles) throw new RangeError('Host resource limit exceeded');
        const id = ++next;
        entries.set(id, { type, value, cleanup });
        if (value && typeof value === 'object') ids.set(value, id);
        return id;
    }
    function get(id, type) {
        const entry = entries.get(id);
        if (closed || !entry || (type && entry.type !== type)) throw new TypeError('Invalid or closed host resource');
        return entry.value;
    }
    function drop(id) { entries.delete(id); }
    function close() {
        if (closed) return;
        closed = true;
        for (const { cleanup } of entries.values()) {
            try { Promise.resolve(cleanup?.()).catch(() => {}); } catch {}
        }
        entries.clear();
    }
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    return { put, get, drop, close, get size() { return entries.size; } };
}
