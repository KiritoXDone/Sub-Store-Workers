const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function notFound() {
    return new Response('Not Found', { status: 404 });
}

// A single private backend path protects management APIs; public shares are
// validated against the same store by Sub-Store's token/resource checks.
export async function handleRequest(request, env, fetchStore, fetchAsset) {
    const configuredPath = String(env?.SUB_STORE_FRONTEND_BACKEND_PATH || '').trim().replace(/\/+$/, '');
    if (!configuredPath.startsWith('/') || configuredPath === '' ||
        /[?#\s]/.test(configuredPath) || configuredPath === '/share' || configuredPath.startsWith('/share/')) {
        return new Response('Backend path is not configured', { status: 503 });
    }
    const url = new URL(request.url);
    const privateRoute = url.pathname === configuredPath || url.pathname.startsWith(configuredPath + '/');
    const shareRoute = /^\/share\/(sub|col|file)\/[^/]+(?:\/[^/]+)?$/.test(url.pathname);
    if (!privateRoute && !shareRoute) {
        if (/^\/(api|dashboard|_internal|share)(?:\/|$)/.test(url.pathname)) return notFound();
        if (fetchAsset && (request.method === 'GET' || request.method === 'HEAD')) return await fetchAsset(request);
        return notFound();
    }
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (!privateRoute && request.method !== 'GET') return notFound();
    if (privateRoute) {
        url.pathname = url.pathname.slice(configuredPath.length) || '/';
        if (url.pathname.startsWith('/_internal/')) return notFound();
    }
    return await fetchStore(new Request(url, request));
}
