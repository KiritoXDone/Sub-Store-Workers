import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from './router.js';
import { createStore } from './storage.js';
import { runSubStoreHttp } from './substore/http.js';
import { runSubStoreCron } from './substore/cron.js';
import { getRequestId, initLogger, error as logError } from './logger.js';
import './register-runtime.js';

function getStore(env) {
    return env.STORE_DO.get(env.STORE_DO.idFromName('store'));
}

function withRequestId(response, requestId) {
    if (response.headers.has('X-Request-Id')) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
    async fetch(request, env) {
        initLogger(env);
        const requestId = getRequestId(request);
        try {
            return withRequestId(await handleRequest(request, env, (forwarded) => getStore(env).fetch(forwarded), (asset) => env.ASSETS.fetch(asset)), requestId);
        } catch (error) {
            logError(`[Worker] [${requestId}] request failed:`, error?.stack || error?.message || error);
            return withRequestId(new Response('Internal Server Error', { status: 500 }), requestId);
        }
    },

    async scheduled(_event, env) {
        initLogger(env);
        try {
            const response = await getStore(env).fetch('https://store/_internal/cron', { method: 'POST' });
            if (!response.ok) throw new Error(`Cron failed: HTTP ${response.status}`);
        } catch (error) {
            logError('[Worker] cron failed:', error?.stack || error?.message || error);
            throw error;
        }
    },
};

export class StoreDO extends DurableObject {
    constructor(state, env) {
        super(state, env);
        this.state = state;
        this.env = env;
        this.store = createStore({ storage: state.storage, env });
        this.tail = Promise.resolve();
    }

    async fetch(request) {
        initLogger(this.env);
        const task = this.tail.then(async () => {
            const data = await this.store.getData();
            const runtimeEnv = {
                ...this.env,
                __mmdbGateway: this.store.mmdbGateway,
                __saveSubStoreData: async (dataString) => {
                    if (dataString != null) await this.store.putData(dataString);
                },
            };
            const url = new URL(request.url);
            if (url.pathname === '/_internal/cron' && request.method === 'POST') {
                await runSubStoreCron({ data: data ?? '{}', env: runtimeEnv, state: this.state });
                return new Response(null, { status: 204 });
            }
            return await runSubStoreHttp({
                data: data ?? '{}', env: runtimeEnv, state: this.state, request,
                subStorePath: url.pathname + url.search,
            });
        });
        this.tail = task.then(() => undefined, () => undefined);
        try {
            return await task;
        } catch (error) {
            logError('[StoreDO] request failed:', error?.stack || error?.message || error);
            return new Response('Internal Server Error', { status: 500 });
        }
    }
}
