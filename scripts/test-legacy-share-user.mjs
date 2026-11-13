import test from 'node:test';
import assert from 'node:assert/strict';
import { findLegacyShareUser } from '../src/molecules/index/findLegacyShareUser.js';
import { parseIndexEntryRoute } from '../src/orchestration/dataOfficer/indexEntryRouteDataOfficer.js';

test('legacy share routing finds only a unique exact match without changing stored data', async () => {
    const users = Array.from({ length: 102 }, (_, index) => ({
        id: index + 1, username: `user${index + 1}`, role: 'user', path: `path${index + 1}`, password_hash: 'secret',
    }));
    const records = new Map([
        [2, JSON.stringify({ 'sub-store': JSON.stringify({ tokens: [{ token: 'old-token', type: 'sub', name: '订阅 A', mode: 'count', count: 1, usedCount: 1, exp: 1 }] }) })],
        [3, JSON.stringify({ 'sub-store': { tokens: [{ token: 'old-token', type: 'col', name: '订阅 A' }] } })],
    ]);
    let active = 0;
    let maxActive = 0;
    const indexGateway = { listUsers: async (afterId, limit) => users.filter((user) => user.id > afterId).slice(0, limit) };
    const userGateway = {
        getUserDataString: async (id) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setImmediate(resolve));
            active -= 1;
            return records.get(id) ?? null;
        },
    };
    const call = (query) => {
        const request = new Request('https://index/_internal/index/user/by-legacy-share', {
            method: 'POST', body: JSON.stringify(query),
        });
        assert.deepEqual(parseIndexEntryRoute(request), { kind: 'legacy-share-user' });
        return findLegacyShareUser({ request, indexGateway, userGateway });
    };
    const query = { token: 'old-token', type: 'sub', name: '订阅 A' };
    const before = records.get(2);
    const unique = await call(query);
    assert.equal(unique.status, 200);
    assert.deepEqual(await unique.json(), { id: 2, username: 'user2', role: 'user', path: 'path2' });
    assert.equal(records.get(2), before);
    assert.equal(maxActive, 4);

    records.set(101, JSON.stringify({ 'sub-store': JSON.stringify({ tokens: [{ ...query }] }) }));
    assert.equal((await call(query)).status, 404);
    assert.equal((await call({ ...query, name: '不存在' })).status, 404);
});
