/**
 * L3 - Molecule
 * Cron 批处理：遍历用户并触发每个用户的 cron，同步游标。
 */

import { info, error as logError } from '../../utils/logger.js';

const CRON_CONCURRENCY = 4;

export async function runCronBatch({ settingsNormalizer, entryGateway }) {
    info('[Cron] 开始执行定时任务...');

    let processed = 0;
    let lastProcessedId = 0;
    let initialUserId = 0;
    let finishedAll = false;
    let stopReason = '';
    try {
        const rawSettings = await entryGateway.getSettings({ requestId: 'cron' });
        const { batchSize, maxUsers, timeBudgetMs, lastUserId } = settingsNormalizer(rawSettings);
        initialUserId = lastUserId;
        lastProcessedId = lastUserId;
        const startTime = Date.now();

        outer: while (true) {
            if (Date.now() - startTime > timeBudgetMs) {
                stopReason = 'time-budget';
                break;
            }

            const page = await entryGateway.listUsers({
                afterId: lastProcessedId,
                limit: batchSize,
                requestId: 'cron',
            });
            if (!Array.isArray(page?.results)) throw new Error('invalid user list response');
            const users = page.results;
            if (users.length === 0) {
                finishedAll = true;
                break;
            }

            for (let offset = 0; offset < users.length;) {
                if (maxUsers > 0 && processed >= maxUsers) {
                    stopReason = 'max-users';
                    break outer;
                }
                if (Date.now() - startTime > timeBudgetMs) {
                    stopReason = 'time-budget';
                    break outer;
                }

                const remaining = maxUsers > 0 ? maxUsers - processed : CRON_CONCURRENCY;
                const group = users.slice(offset, offset + Math.min(CRON_CONCURRENCY, remaining));
                const results = await Promise.allSettled(group.map((user) =>
                    Promise.resolve().then(() => entryGateway.triggerUserCron({ user, requestId: 'cron' })),
                ));
                // Only advance over the successful prefix; later successes can be retried.
                for (let i = 0; i < group.length; i += 1) {
                    if (results[i].status !== 'fulfilled' || results[i].value !== true) {
                        logError(`[Cron] 用户 ${group[i].id} 执行失败:`, results[i].reason || 'unsuccessful response');
                        stopReason = 'user-failed';
                        break outer;
                    }
                    processed += 1;
                    lastProcessedId = group[i].id;
                }
                offset += group.length;
            }
        }
        if (stopReason === 'max-users') {
            info(`[Cron] 已达到本次最大处理上限: ${maxUsers}`);
        } else if (stopReason === 'time-budget') {
            info(`[Cron] 超出时间预算(${timeBudgetMs}ms)，提前结束`);
        }
    } catch (err) {
        logError('[Cron] 定时任务执行失败:', err?.stack || err?.message || err);
        finishedAll = false;
        stopReason = 'error';
    }

    try {
        if (finishedAll || lastProcessedId !== initialUserId) {
            const saved = await entryGateway.patchSettings({
                patch: { cronLastUserId: finishedAll ? 0 : lastProcessedId },
                requestId: 'cron',
            });
            if (!saved) throw new Error('cursor update failed');
        }
    } catch (err) {
        logError('[Cron] 保存游标失败:', err?.stack || err?.message || err);
        finishedAll = false;
        stopReason = 'error';
    }

    info(`[Cron] 定时任务执行完成，处理用户数: ${processed}`);
    return { processed, finishedAll, stopReason };
}
