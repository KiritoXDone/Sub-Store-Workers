import { jsonResponse, errorResponse } from '../../atoms/http/httpAtoms.js';

export async function getUserById({ route, indexGateway }) {
    if (!Number.isSafeInteger(route.userId) || route.userId <= 0) return errorResponse('Not Found', 404);
    const row = await indexGateway.getUserById(route.userId);
    if (!row) return errorResponse('Not Found', 404);
    return jsonResponse({ id: row.id, username: row.username, role: row.role, path: row.path });
}
