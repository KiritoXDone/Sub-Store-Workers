import { parse } from 'acorn';

const CACHE_KEYS = {
    '/utils/resource-cache.js': 'RESOURCE_CACHE_KEY',
    '/utils/script-resource-cache.js': 'SCRIPT_RESOURCE_CACHE_KEY',
    '/utils/headers-resource-cache.js': 'HEADERS_RESOURCE_CACHE_KEY',
};

export function transformResourceCache(source, id) {
    const entry = Object.entries(CACHE_KEYS).find(([suffix]) => id.endsWith(suffix));
    if (!entry) return source;
    const [, key] = entry;
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const cacheClass = ast.body.find((node) => node.type === 'ClassDeclaration' && node.id?.name === 'ResourceCache');
    const constructor = cacheClass?.body.body.find((node) => node.type === 'MethodDefinition' && node.kind === 'constructor');
    const methods = new Set(cacheClass?.body.body.map((node) => node.key?.name));
    const original = constructor && source.slice(constructor.start, constructor.end);
    if (!constructor || !original.includes(`JSON.parse($.read(${key}))`) || !original.includes('this._cleanup()') ||
        methods.has('resourceCache') || !['_cleanup', '_persist', 'get', 'set', 'revokeAll'].every((name) => methods.has(name))) {
        throw new Error(`[sub-store-cache] upstream cache contract changed: ${id}`);
    }

    // Each request owns its cache snapshot; the existing upstream _persist() still
    // writes to the same per-user storage key and format.
    const replacement = `constructor() {}
    get resourceCache() {
        const context = globalThis.__substore_get_active_context__?.();
        if (!context) throw new Error('Sub-Store resource cache context unavailable');
        const caches = context.resourceCaches || (context.resourceCaches = Object.create(null));
        if (!Object.prototype.hasOwnProperty.call(caches, ${key})) {
            const saved = $.read(${key});
            const value = saved == null || saved === '' ? {} : JSON.parse(saved);
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('Invalid stored Sub-Store resource cache');
            }
            caches[${key}] = value;
            this._cleanup();
        }
        return caches[${key}];
    }
    set resourceCache(value) {
        const context = globalThis.__substore_get_active_context__?.();
        if (!context) throw new Error('Sub-Store resource cache context unavailable');
        const caches = context.resourceCaches || (context.resourceCaches = Object.create(null));
        caches[${key}] = value;
    }`;
    return source.slice(0, constructor.start) + replacement + source.slice(constructor.end);
}
