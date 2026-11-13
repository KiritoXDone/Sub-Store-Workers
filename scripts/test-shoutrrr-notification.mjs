import assert from 'node:assert/strict';
import test from 'node:test';
import { sendShoutrrrNotification } from '../src/shoutrrr.js';

test('Shoutrrr uses fetch for delivery and reports unsupported channels', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
    };
    try {
        await sendShoutrrrNotification({ url: 'ntfy://ntfy.sh/local-test' }, 'Title', 'Subtitle', 'Body');
        assert.equal(requests.length, 1);
        assert.ok(requests[0].url.startsWith('https://ntfy.sh/'));
        assert.ok(requests[0].init.signal instanceof AbortSignal);
        assert.ok(String(requests[0].init.body).includes('Body'));
        await assert.rejects(sendShoutrrrNotification({ url: 'unsupported://example.test' }, 'Title'), /not supported|invalid/i);
        assert.equal(requests.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
