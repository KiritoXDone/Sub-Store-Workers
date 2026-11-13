import { initSubStore } from './loader.js';
import { warn, error as logError } from '../logger.js';
import { createSubStoreStorage, prepareSubStoreRuntime, readSubStoreCache } from './runtime.js';
import { createSubStoreRequestContext, deleteSubStoreRequestContext, flushSubStoreRequestContext, runWithSubStoreContext } from './context.js';

async function buildSubStoreRequest(request, subStorePath) {
    const originalUrl = new URL(request.url);
    const rewrittenUrl = new URL(originalUrl);
    rewrittenUrl.pathname = String(subStorePath || '').split('?')[0];

    let body = '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
            body = await request.text();
        } catch {
            body = '';
        }
    }

    const headers = {};
    request.headers.forEach((value, key) => {
        headers[key] = value;
    });

    return {
        method: request.method,
        url: rewrittenUrl.href,
        path: subStorePath,
        headers,
        body,
    };
}

function buildResponseFromSubStoreResult(result) {
    if (!result) return new Response('No response', { status: 500 });

    const CORS_HEADERS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,PATCH,PUT,DELETE',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
    };

    const response = result.response || result;

    let status = 200;
    if (typeof response.status === 'number') status = response.status;
    else if (typeof response.status === 'string') {
        const match = response.status.match(/\d+/);
        status = match ? parseInt(match[0], 10) : 200;
    }

    return new Response(response.body || '', {
        status,
        headers: response.headers || { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
    });
}

async function executeSubStoreRequest({ $request, subStoreContext, requestId, timeoutMs, timeoutLabel }) {
    let timeoutId = null;
    return await new Promise((resolve) => {
        subStoreContext.done = (res) => {
            if (timeoutId) clearTimeout(timeoutId);
            subStoreContext.done = null;
            resolve({ result: res, timedOut: false });
        };

        timeoutId = setTimeout(() => {
            warn(`[SubStoreAtom] [${requestId}] ${timeoutLabel}`);
            subStoreContext.done = null;
            resolve({
                result: {
                    status: 504,
                    body: JSON.stringify({ status: 'failed', message: 'Gateway Timeout' }),
                    headers: { 'Content-Type': 'application/json' },
                },
                timedOut: true,
            });
        }, timeoutMs);

        initSubStore($request).catch((e) => {
            if (timeoutId) clearTimeout(timeoutId);
            subStoreContext.done = null;
            logError(`[SubStoreAtom] [${requestId}] initSubStore failed:`, e?.stack || e?.message || e);
            resolve({ result: { status: 500, body: 'Internal Server Error' }, timedOut: false, initializationFailed: true });
        });
    });
}

export async function runSubStoreHttp({ data, env, state, request, subStorePath }) {
    const requestId = `http-${crypto.randomUUID()}`;
    const globals = await prepareSubStoreRuntime({ env, state, requestId });
    let context;
    const storage = createSubStoreStorage(data, (store) => {
        context.dirty = true;
        context.storeData = store;
    });
    const $request = await buildSubStoreRequest(request, subStorePath);
    $request.__requestId = requestId;
    context = createSubStoreRequestContext({
        requestId, request: $request, env, persistentStore: storage,
        notification: globals.notification, environment: globals.environment,
        cache: readSubStoreCache(storage),
    });

    try {
        const { result, initializationFailed } = await runWithSubStoreContext(context, async () => await executeSubStoreRequest({
            $request, subStoreContext: context, requestId, timeoutMs: 25000, timeoutLabel: '请求超时',
        }));
        if (!initializationFailed) {
            const dataString = flushSubStoreRequestContext(context);
            if (dataString !== null) {
                if (typeof env?.__saveSubStoreData !== 'function') throw new Error('Sub-Store data writer unavailable');
                await env.__saveSubStoreData(dataString);
            }
        }
        return buildResponseFromSubStoreResult(result);
    } finally {
        deleteSubStoreRequestContext(requestId);
    }
}
