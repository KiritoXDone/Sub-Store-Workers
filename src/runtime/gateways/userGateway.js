/**
 * L2 Runtime Gateway
 *
 * User 域状态访问契约：
 * - user_data / user_store / access_log
 * - 具体实现由 runtime adapter 提供（Workers / Deno）
 * - 详细约束见 src/orchestration/atomApiDoc/runtime/userGatewayDoc.js
 */

/**
 * @typedef {Object} UserDomainGateway
 * @property {(userId: number) => Promise<string|null>} getUserDataString
 * @property {(userId: number) => Promise<{data: string|null, revision?: string|null}>} getUserDataSnapshot 读取后用于整份数据的条件写入
 * @property {(userId: number, snapshot: {data: string|null, revision?: string|null}, dataString: string) => Promise<boolean>} compareAndPutUserDataString 原子地检查快照并写入；冲突时返回 false
 * @property {(userId: number, dataString: string) => Promise<void>} putUserDataString 写 user_data；非 DO 平台必须事务+userId 锁
 * @property {(userId: number) => Promise<void>} deleteUserDataString 删 user_data；非 DO 平台必须事务+userId 锁
 * @property {(userId: number, key: string) => Promise<string|null>} getUserStoreValue
 * @property {(userId: number, key: string, value: string) => Promise<void>} putUserStoreValue 写 user_store；非 DO 平台必须事务+userId 锁
 * @property {(userId: number, key: string) => Promise<void>} deleteUserStoreKey 删 user_store；非 DO 平台必须事务+userId 锁
 * @property {(userId: number, entry: Record<string, unknown>) => Promise<void>} appendAccessLog 追加访问日志；非 DO 平台必须事务+userId 锁
 * @property {(userId: number, args: { limit: number, beforeId: number }) => Promise<{results: Array<Record<string, unknown>>, nextBeforeId: number|null}>} listAccessLog
 */

/**
 * @param {UserDomainGateway} impl
 * @returns {UserDomainGateway}
 */
export function createUserGateway(impl) {
    return impl;
}
