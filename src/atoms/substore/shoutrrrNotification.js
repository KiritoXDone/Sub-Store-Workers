import { send } from '../../../sub-store/backend/node_modules/shoutrrr-ts/dist/index.js';

// Keep delivery on the runtime's fetch transport, including its TLS policy.
export async function sendShoutrrrNotification(config, title, subtitle, content) {
    if (!config?.url) throw new Error('缺少通知服务 URL');
    await send(config.url, [title, subtitle, content].filter(Boolean).join('\n'), {
        transport: (url, init = {}) => {
            const method = (init.method || 'GET').toUpperCase();
            if (['GET', 'HEAD'].includes(method) && init.body != null) {
                throw new Error('当前运行环境不支持 GET/HEAD 请求体');
            }
            const timeout = AbortSignal.timeout(8000);
            const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
            return fetch(url, { ...init, signal });
        },
    });
}
