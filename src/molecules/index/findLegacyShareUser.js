import { buildNotFoundResponse, jsonResponse, readJsonBody } from '../../atoms/http/httpAtoms.js';

const PAGE_SIZE = 100;
const READ_CONCURRENCY = 4;

function parseObject(value) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value;
}

function containsShare(rawData, { token, type, name }) {
    const userData = parseObject(rawData);
    const subStore = parseObject(userData?.['sub-store']);
    const storedTokens = parseObject(subStore?.tokens);
    const tokens = Array.isArray(storedTokens)
        ? storedTokens
        : storedTokens && typeof storedTokens === 'object' ? Object.values(storedTokens) : [];
    return tokens.some((item) => item?.token === token && item?.type === type && item?.name === name);
}

export async function findLegacyShareUser({ request, indexGateway, userGateway }) {
    const query = await readJsonBody(request);
    if (typeof query?.token !== 'string' || !query.token ||
        !['sub', 'col', 'file'].includes(query.type) || typeof query.name !== 'string' || !query.name) {
        return buildNotFoundResponse();
    }

    let afterId = 0;
    let match = null;
    while (true) {
        const users = await indexGateway.listUsers(afterId, PAGE_SIZE);
        if (!Array.isArray(users)) throw new Error('Invalid user list response');
        if (users.length === 0) break;
        const lastId = users[users.length - 1]?.id;
        if (lastId == null || BigInt(lastId) <= BigInt(afterId)) throw new Error('Invalid user list cursor');

        for (let offset = 0; offset < users.length; offset += READ_CONCURRENCY) {
            const matches = await Promise.all(users.slice(offset, offset + READ_CONCURRENCY).map(async (user) => {
                const data = await userGateway.getUserDataString(user.id);
                return containsShare(data, query) ? user : null;
            }));
            for (const user of matches) {
                if (!user) continue;
                if (match && String(match.id) !== String(user.id)) return buildNotFoundResponse();
                match = user;
            }
        }

        if (users.length < PAGE_SIZE) break;
        afterId = lastId;
    }

    if (!match) return buildNotFoundResponse();
    return jsonResponse({ id: match.id, username: match.username, role: match.role, path: match.path });
}
