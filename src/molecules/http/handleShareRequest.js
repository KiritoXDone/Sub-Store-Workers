import { buildNotFoundResponse } from '../../atoms/http/httpAtoms.js';

// The user id only routes the request; the tenant's Sub-Store validates the full token.
export async function handleShareRequest({ request, requestId, entryGateway }) {
    const url = new URL(request.url);
    const resource = /^\/share\/(sub|col|file)\/([^/]+)(?:\/[^/]+)?$/.exec(url.pathname);
    if (request.method !== 'GET' || !resource) {
        return buildNotFoundResponse();
    }
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1 || !tokens[0]) return buildNotFoundResponse();
    const match = /^u([1-9]\d*)\.(.+)$/.exec(tokens[0]);
    let user;
    if (match) {
        const userId = Number(match[1]);
        if (!Number.isSafeInteger(userId) || userId <= 0) return buildNotFoundResponse();
        user = await entryGateway.getUserById({ userId, requestId });
    } else {
        let name;
        try { name = decodeURIComponent(resource[2]); } catch { return buildNotFoundResponse(); }
        user = await entryGateway.findLegacyShareUser({ token: tokens[0], type: resource[1], name, requestId });
    }
    if (!user) return buildNotFoundResponse();
    return await entryGateway.forwardSubStoreRequest({ request, user, requestId, preservePath: true });
}
