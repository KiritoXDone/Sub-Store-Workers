/**
 * Sub-Store HTTP 客户端适配器
 * 使用 Workers 原生 fetch 实现 Surge $httpClient 接口
 */

import { debug, warn, error } from './logger.js';

export function createHttpClient() {
    const methods = ['get', 'post', 'put', 'delete', 'head', 'options', 'patch'];

    const client = {};

    methods.forEach((method) => {
        client[method] = (opts, callback) => {
            const options = typeof opts === 'string' ? { url: opts } : { ...opts };

            debug(`[HTTP] 请求: ${method.toUpperCase()} ${options.url}`);

            const fetchOptions = {
                method: method.toUpperCase(),
                headers: { ...options.headers } || {},
            };

            // 仅普通对象编码为 JSON；二进制和表单类型保持原样。
            const body = options.body;
            if (body != null && !(body === '' && (method === 'get' || method === 'head'))) {
                const prototype = typeof body === 'object' ? Object.getPrototypeOf(body) : undefined;
                if (prototype === Object.prototype || prototype === null) {
                    fetchOptions.body = JSON.stringify(body);
                    fetchOptions.headers['Content-Type'] =
                        fetchOptions.headers['Content-Type'] || 'application/json';
                } else {
                    fetchOptions.body = body;
                }
            }

            // Surge $httpClient 的 timeout 单位为秒。保留项目的 55 秒上限。
            const seconds = Number(options.timeout);
            const timeout = Number.isFinite(seconds) && seconds > 0
                ? Math.min(seconds * 1000, 55000)
                : 30000;

            const controller = new AbortController();
            const signal = options.signal;
            const abortFromCaller = () => controller.abort(signal?.reason);
            if (signal?.aborted) abortFromCaller();
            else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
            const timeoutId = setTimeout(() => {
                warn(`[HTTP] 超时: ${timeout}ms - ${options.url}`);
                controller.abort();
            }, timeout);
            fetchOptions.signal = controller.signal;

            // Workers 不支持某些 fetch 选项，需要移除
            // 例如：insecureHTTPParser, rejectUnauthorized 等
            delete fetchOptions.insecure;
            delete fetchOptions.rejectUnauthorized;

            Promise.resolve()
                .then(() => fetch(options.url, fetchOptions))
                .then(async (response) => {
                    let body;

                    if (options.encoding === null) {
                        // 返回 ArrayBuffer
                        body = await response.arrayBuffer();
                    } else {
                        body = await response.text();
                    }

                    // 转换 headers 为普通对象
                    const headers = {};
                    response.headers.forEach((value, key) => {
                        headers[key] = value;
                    });

                    debug(`[HTTP] 响应: ${method.toUpperCase()} ${options.url} -> ${response.status}`);

                    return [{
                        status: response.status,
                        statusCode: response.status,
                        headers: headers,
                    }, body];
                })
                .then(([response, body]) => {
                    clearTimeout(timeoutId);
                    signal?.removeEventListener?.('abort', abortFromCaller);
                    callback(null, response, body);
                }, (err) => {
                    clearTimeout(timeoutId);
                    signal?.removeEventListener?.('abort', abortFromCaller);
                    error(`[HTTP] 错误: ${method.toUpperCase()} ${options.url} - ${err?.message || String(err)}`);
                    callback(err?.message || String(err), null, null);
                });
        };
    });

    return client;
}
