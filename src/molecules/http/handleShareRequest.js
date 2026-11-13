import { buildNotFoundResponse } from '../../atoms/http/httpAtoms.js';

// The user id only routes the request; the tenant's Sub-Store validates the full token.
export async function handleShareRequest({ request, requestId, entryGateway }) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !/^\/share\/(sub|col|file)\/[^/]+(?:\/[^/]+)?$/.test(url.pathname)) {
        return buildNotFoundResponse();
    }
    const tokens = url.searchParams.getAll('token');
    const match = tokens.length === 1 && /^u([1-9]\d*)\.(.+)$/.exec(tokens[0]);
    const userId = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(userId) || userId <= 0) return buildNotFoundResponse();
    const user = await entryGateway.getUserById({ userId, requestId });
    if (!user) return buildNotFoundResponse();
    return await entryGateway.forwardSubStoreRequest({ request, user, requestId, preservePath: true });
}
