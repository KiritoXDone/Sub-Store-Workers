import { sendShoutrrrNotification } from './shoutrrr.js';
import { warn } from './logger.js';

export function createNotificationGateway(pushService, lifetime) {
    const service = typeof pushService === 'string' ? pushService.trim() : '';
    return {
        post(title = '', subtitle = '', content = '', options = {}) {
            if (!service) return;
            const body = String(content || '') + (options.url ? `\n点击跳转: ${options.url}` : '');
            const send = async () => {
                if (/^https?:\/\//i.test(service)) {
                    const url = service
                        .replace('[推送标题]', encodeURIComponent(title || 'Sub-Store'))
                        .replace('[推送内容]', encodeURIComponent([subtitle, body].join('\n')));
                    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
                    if (!response.ok) throw new Error('Notification request failed');
                } else {
                    await sendShoutrrrNotification({ url: service }, title, subtitle, body);
                }
            };
            const task = send().catch(() => warn('[Notification] delivery failed'));
            if (lifetime?.waitUntil) lifetime.waitUntil(task);
        },
    };
}
