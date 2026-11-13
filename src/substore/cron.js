import { initSubStore } from './loader.js';
import { warn, error as logError } from '../logger.js';
import { createSubStoreStorage, prepareSubStoreRuntime, readSubStoreCache } from './runtime.js';
import { createSubStoreRequestContext, deleteSubStoreRequestContext, flushSubStoreRequestContext, runWithSubStoreContext } from './context.js';

export async function runSubStoreCron({ data, env, state }) {
    const requestId = `cron-${crypto.randomUUID()}`;
    const globals = await prepareSubStoreRuntime({ env, state, requestId });
    let context;
    const storage = createSubStoreStorage(data, (store) => {
        context.dirty = true;
        context.storeData = store;
    });
    const $request = {
        method: 'GET',
        url: 'https://substore.internal/api/sync/artifacts',
        path: '/api/sync/artifacts',
        headers: {},
        body: '',
        __requestId: requestId,
    };
    context = createSubStoreRequestContext({
        requestId, request: $request, env, persistentStore: storage,
        notification: globals.notification, environment: globals.environment,
        cache: readSubStoreCache(storage),
    });

    try {
        const responseError = await runWithSubStoreContext(context, async () => {
            let timeoutId;
            return await new Promise((resolve, reject) => {
                context.done = (result) => {
                    clearTimeout(timeoutId);
                    context.done = null;
                    const status = Number(result?.response?.status ?? result?.status ?? 200);
                    resolve(status >= 400 ? new Error(`Cron sync returned ${status}`) : null);
                };
                timeoutId = setTimeout(() => {
                    warn(`[SubStore] [${requestId}] cron timeout`);
                    context.done = null;
                    reject(new Error('Cron sync timed out'));
                }, 60000);
                initSubStore($request).catch((error) => {
                    clearTimeout(timeoutId);
                    context.done = null;
                    logError(`[SubStore] [${requestId}] initialization failed:`, error?.message || error);
                    reject(error);
                });
            });
        });
        const dataString = flushSubStoreRequestContext(context);
        if (dataString !== null) {
            if (typeof env?.__saveSubStoreData !== 'function') throw new Error('Sub-Store data writer unavailable');
            await env.__saveSubStoreData(dataString);
        }
        if (responseError) throw responseError;
    } finally {
        deleteSubStoreRequestContext(requestId);
    }
}
