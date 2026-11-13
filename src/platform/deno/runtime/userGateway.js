import { createUserGateway } from '../../../runtime/gateways/userGateway.js';
import { withPgTransaction } from './postgres/withPgTransaction.js';
import { withPgAdvisoryLock } from './postgres/withPgAdvisoryLock.js';

const ACCESS_LOG_MAX_ROWS = 5000;
const ACCESS_LOG_CLEANUP_INTERVAL = 64;
const ACCESS_LOG_COUNTER_LIMIT = 2048;

function toSafeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
}

function normalizeAccessLogRow(row) {
    return {
        ...row,
        id: toSafeNumber(row?.id),
        ts: toSafeNumber(row?.ts),
        status: row?.status == null ? row?.status : toSafeNumber(row.status),
    };
}

export function createDenoUserGateway({ pool, now = () => Date.now() }) {
    const logWritesSinceCleanup = new Map();
    return createUserGateway({
        async getUserDataString(userId) {
            const result = await pool.query(
                'SELECT value FROM user_store WHERE user_id = $1 AND key = $2',
                [userId, 'user_data'],
            );
            return result.rows?.[0]?.value ?? null;
        },

        async getUserDataSnapshot(userId) {
            const result = await pool.query(
                'SELECT value, xmin::text AS revision FROM user_store WHERE user_id = $1 AND key = $2',
                [userId, 'user_data'],
            );
            const row = result.rows?.[0];
            return row ? { data: row.value, revision: row.revision } : { data: null, revision: null };
        },

        async compareAndPutUserDataString(userId, snapshot, dataString) {
            return await withPgTransaction(pool, async (client) => {
                return await withPgAdvisoryLock(client, { scope: 'user-store', entity: userId }, async () => {
                    const result = snapshot.revision === null
                        ? await client.query(
                            'INSERT INTO user_store (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO NOTHING',
                            [userId, 'user_data', dataString, now()],
                        )
                        : await client.query(
                            'UPDATE user_store SET value = $3, updated_at = $4 WHERE user_id = $1 AND key = $2 AND xmin::text = $5',
                            [userId, 'user_data', dataString, now(), snapshot.revision],
                        );
                    return result.rowCount === 1;
                });
            });
        },

        async putUserDataString(userId, dataString) {
            await withPgTransaction(pool, async (client) => {
                await withPgAdvisoryLock(client, { scope: 'user-store', entity: userId }, async () => {
                    await client.query(
                        'INSERT INTO user_store (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
                        [userId, 'user_data', dataString, now()],
                    );
                });
            });
        },

        async deleteUserDataString(userId) {
            await withPgTransaction(pool, async (client) => {
                await withPgAdvisoryLock(client, { scope: 'user-store', entity: userId }, async () => {
                    await client.query('DELETE FROM user_store WHERE user_id = $1 AND key = $2', [userId, 'user_data']);
                });
            });
        },

        async getUserStoreValue(userId, key) {
            const result = await pool.query(
                'SELECT value FROM user_store WHERE user_id = $1 AND key = $2',
                [userId, key],
            );
            return result.rows?.[0]?.value ?? null;
        },

        async putUserStoreValue(userId, key, value) {
            await withPgTransaction(pool, async (client) => {
                await withPgAdvisoryLock(client, { scope: 'user-store', entity: userId }, async () => {
                    await client.query(
                        'INSERT INTO user_store (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
                        [userId, key, value, now()],
                    );
                });
            });
        },

        async deleteUserStoreKey(userId, key) {
            await withPgTransaction(pool, async (client) => {
                await withPgAdvisoryLock(client, { scope: 'user-store', entity: userId }, async () => {
                    await client.query('DELETE FROM user_store WHERE user_id = $1 AND key = $2', [userId, key]);
                });
            });
        },

        async appendAccessLog(userId, entry) {
            let nextCount;
            await withPgTransaction(pool, async (client) => {
                await withPgAdvisoryLock(client, { scope: 'user-access-log', entity: userId }, async () => {
                    await client.query(
                        'INSERT INTO download_access_log (user_id, ts, kind, name, target, status, path, ua, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                        [
                            userId,
                            entry.ts,
                            entry.kind,
                            entry.name,
                            entry.target ?? null,
                            entry.status ?? null,
                            entry.path ?? null,
                            entry.ua ?? null,
                            entry.ip ?? null,
                        ],
                    );
                    const count = logWritesSinceCleanup.get(userId);
                    const shouldClean = count === undefined || count >= ACCESS_LOG_CLEANUP_INTERVAL - 1;
                    if (shouldClean) {
                        await client.query(
                            'DELETE FROM download_access_log WHERE id IN (SELECT id FROM download_access_log WHERE user_id = $1 ORDER BY id DESC OFFSET $2)',
                            [userId, ACCESS_LOG_MAX_ROWS],
                        );
                    }
                    nextCount = shouldClean ? 0 : count + 1;
                });
            });
            logWritesSinceCleanup.delete(userId);
            logWritesSinceCleanup.set(userId, nextCount);
            if (logWritesSinceCleanup.size > ACCESS_LOG_COUNTER_LIMIT) {
                logWritesSinceCleanup.delete(logWritesSinceCleanup.keys().next().value);
            }
        },

        async listAccessLog(userId, { limit, beforeId }) {
            const params = [userId, limit];
            let sql = 'SELECT id, ts, kind, name, target, status, path, ua, ip FROM download_access_log WHERE user_id = $1';
            if (beforeId > 0) {
                sql += ' AND id < $3';
                params.push(beforeId);
            }
            sql += ' ORDER BY id DESC LIMIT $2';
            const result = await pool.query(sql, params);
            const rows = result.rows.map(normalizeAccessLogRow);
            const nextBeforeId = rows.length > 0 ? rows[rows.length - 1].id : null;
            return { results: rows, nextBeforeId };
        },
    });
}
