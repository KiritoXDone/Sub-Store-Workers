import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const worker = process.argv[2] || 'http://127.0.0.1:3000';
const prefix = process.env.SUB_STORE_FRONTEND_BACKEND_PATH || '/local-test-backend';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(worker).hostname), 'Only run this fixture against a local Worker');
const server = createServer((request, response) => {
    if (request.url === '/slow') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('part');
        const timer = setTimeout(() => response.end('end'), 250);
        response.on('close', () => clearTimeout(timer));
        return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString() }));
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const echo = `http://127.0.0.1:${server.address().port}/echo`;
const script = `async function operator(nodes) {
    const url = new URL('https://example.com/?q=ok');
    url.searchParams.set('extra', 'a b');
    if (url.searchParams.get('q') !== 'ok' || !url.search.includes('a+b')) throw new Error('URL');
    const hash = require('node:crypto').createHash('sha256').update('abc').digest('hex');
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))).toString('hex');
    if (hash !== digest || hash !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('crypto');
    const input = new TextEncoder().encode('crypto');
    const hmac = await crypto.subtle.importKey('raw', new Uint8Array([1, 2, 3]), { name:'HMAC', hash:'SHA-256' }, false, ['sign', 'verify']);
    const signature = await crypto.subtle.sign('HMAC', hmac, input);
    if (!await crypto.subtle.verify('HMAC', hmac, signature, input)) throw new Error('HMAC');
    const key = await crypto.subtle.generateKey({ name:'AES-GCM', length:128 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, input);
    if (new TextDecoder().decode(await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, encrypted)) !== 'crypto') throw new Error('AES-GCM');
    const mod = await import('node:buffer');
    if (mod.Buffer.from([255]).toString('base64url') !== '_w') throw new Error('import/buffer');
    let rejected = false;
    try { require('node:fs'); } catch { rejected = true; }
    if (!rejected) throw new Error('module boundary');
    const Emitter = require('node:events'); const emitter = new Emitter(); let emitted = 0;
    emitter.once('value', value => emitted += value); emitter.emit('value', 2); emitter.emit('value', 2);
    if (emitted !== 2 || !require('node:stream/web').ReadableStream) throw new Error('modules');
    const cyclic = { date: new Date(0), map: new Map() }; cyclic.map.set('self', cyclic);
    if (structuredClone(cyclic).map.get('self').date.getTime() !== 0) throw new Error('structuredClone');
    const file = new File(['abc'], 'fixture.txt', { type: 'text/plain', lastModified: 42 });
    const form = new FormData(); form.append('file', file); form.append('tag', 'first'); form.append('tag', 'second');
    const req = new Request('https://example.com/upload', { method: 'POST', body: form });
    const restored = await req.clone().formData();
    if (!(restored.get('file') instanceof File) || await restored.get('file').text() !== 'abc' || restored.getAll('tag').length !== 2) throw new Error('form/file');
    const response = await fetch(${JSON.stringify(echo)}, { method: 'POST', body: 'worker-fetch' });
    const echoed = await response.json();
    if (echoed.method !== 'POST' || echoed.body !== 'worker-fetch') throw new Error('fetch');
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('流')); c.close(); } });
    if (await new Response(stream).text() !== '流') throw new Error('streams');
    const controller = new AbortController(); controller.abort();
    try { await fetch(${JSON.stringify(echo)}, { signal: controller.signal }); throw new Error('abort ignored'); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
    const late = new AbortController();
    const pending = await fetch(${JSON.stringify(echo.replace('/echo', '/slow'))}, { signal: late.signal });
    setTimeout(() => late.abort(), 15);
    try { await pending.text(); throw new Error('late abort ignored'); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
    nodes[0].name = 'CAPABILITIES_OK'; return nodes;
}`;
try {
    const response = await fetch(worker + prefix + '/api/preview/sub?target=JSON', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'capability-fixture', source: 'local', content: 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#node',
            process: [{ type: 'Script Operator', args: { mode: 'script', content: script } }] }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, 'success', JSON.stringify(body));
    assert.equal(body.data?.processed?.[0]?.name, 'CAPABILITIES_OK', JSON.stringify(body));
    console.log('PASS: Worker preview runs URL, require/import, Buffer, Web Crypto, File/FormData, fetch, streams and abort');
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
