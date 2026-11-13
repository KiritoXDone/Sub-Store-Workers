export function createWebApi(resources, lifetime, { fetchImpl = globalThis.fetch, maxBodyBytes = 8 * 1024 * 1024 } = {}) {
    const { put, get, drop } = resources;
    const readers = new Map(), requestControllers = new Map();
    lifetime.addEventListener('abort',()=>{for(const controller of requestControllers.values())controller.abort();requestControllers.clear();readers.clear();},{once:true});
    const disposeBody = value => () => { if (value.body && !value.body.locked) return value.body.cancel(); };
    const wrapHeaders = headers => put('headers', headers);
    function wrap(value) {
        if (value instanceof File) return { type: 'file', id: put('file', value), size: value.size, mime: value.type, name: value.name, lastModified: value.lastModified };
        if (value instanceof Blob) return { type: 'blob', id: put('blob', value), size: value.size, mime: value.type };
        if (value instanceof Request) return { type: 'request', id: put('request', value, disposeBody(value)) };
        if (value instanceof Response) return { type: 'response', id: put('response', value, disposeBody(value)) };
        if (value instanceof Headers) return { type: 'headers', id: wrapHeaders(value) };
        if (value instanceof FormData) return { type: 'form', id: put('form', value) };
        return value;
    }
    function body(value) {
        if (!value || !value.__body) return value;
        if (value.__body === 'blob') return get(value.id, 'blob');
        if (value.__body === 'file') return get(value.id, 'file');
        if (value.__body === 'form') return get(value.id, 'form');
        if (value.__body === 'upload') return get(value.id, 'upload').stream.readable;
        if (value.__body === 'params') return new URLSearchParams(value.text);
        throw new TypeError('Unsupported body descriptor');
    }
    function options(init = {}) {
        const result = { ...init };
        if (result.headers?.__headers) result.headers = get(result.headers.id, 'headers');
        if ('body' in result) result.body = body(result.body);
        if (result.body instanceof ReadableStream) result.duplex = 'half';
        delete result.signal;
        return result;
    }
    async function readLimited(stream) {
        if (!stream) return new Uint8Array();
        const reader = stream.getReader();
        const id = put('reading', reader, () => reader.cancel());
        const chunks = []; let length = 0;
        try {
            while (true) {
                const item = await reader.read();
                if (item.done) break;
                length += item.value.byteLength;
                if (length > maxBodyBytes) { await reader.cancel(); throw new RangeError('Body size limit exceeded'); }
                chunks.push(item.value);
            }
            const out = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
            return out;
        } finally { drop(id); reader.releaseLock(); }
    }
    async function consume(id, type, mode) {
        const value = get(id, type);
        if (value.bodyUsed || value.body?.locked) throw new TypeError('Body already used or locked');
        const bytes = await readLimited(value.body);
        if (mode === 'arrayBuffer') return bytes.buffer;
        if (mode === 'bytes') return bytes;
        if (mode === 'text') return new TextDecoder().decode(bytes);
        if (mode === 'json') return JSON.parse(new TextDecoder().decode(bytes));
        if (mode === 'blob') return wrap(new Blob([bytes], { type: value.headers.get('content-type') || '' }));
        if (mode === 'formData') return wrap(await new Response(bytes, { headers: value.headers }).formData());
        throw new TypeError('Unsupported body method');
    }
    return {
        headersNew(init) { return wrap(new Headers(init?.__headers ? get(init.id, 'headers') : init)); },
        headers(id, operation, args) {
            const headers = get(id, 'headers');
            if (!['get','getSetCookie','set','append','delete','has','entries','keys','values'].includes(operation)) throw new TypeError('Invalid Headers operation');
            const result = headers[operation](...args);
            return ['entries','keys','values'].includes(operation) ? Array.from(result) : result;
        },
        blobNew(parts, init, file) {
            const decoded = parts.map(body);
            return wrap(file ? new File(decoded, file.name, { ...init, lastModified: file.lastModified }) : new Blob(decoded, init));
        },
        blobSlice(id, type, start, end, mime) { return wrap(get(id, type).slice(start, end, mime)); },
        async blobRead(id, type, mode) {
            const blob = get(id, type);
            if (blob.size > maxBodyBytes) throw new RangeError('Body size limit exceeded');
            if (mode === 'text') return blob.text();
            if (mode === 'bytes') return new Uint8Array(await blob.arrayBuffer());
            if (mode === 'arrayBuffer') return blob.arrayBuffer();
            throw new TypeError('Invalid Blob operation');
        },
        formNew() { return wrap(new FormData()); },
        form(id, operation, args) {
            const form = get(id, 'form');
            if (!['get','getAll','set','append','delete','has','entries','keys','values'].includes(operation)) throw new TypeError('Invalid FormData operation');
            if (operation === 'set' || operation === 'append') args = [args[0], body(args[1]), ...args.slice(2)];
            const result = form[operation](...args);
            if (operation === 'entries') return Array.from(result, ([key,value]) => [key,wrap(value)]);
            if (['getAll','values'].includes(operation)) return Array.from(result, wrap);
            if (operation === 'keys') return Array.from(result);
            return wrap(result);
        },
        requestNew(input, init) {
            const controller = new AbortController();
            const request = new Request(input?.__request ? get(input.id, 'request') : input, { ...options(init), signal: controller.signal });
            const result = wrap(request);
            requestControllers.set(result.id, controller);
            return result;
        },
        responseNew(value, init) { return wrap(new Response(body(value), options(init))); },
        responseStatic(operation, args) {
            if (!['json','redirect','error'].includes(operation)) throw new TypeError('Invalid Response factory');
            if (operation === 'json' && args[1]) args[1] = options(args[1]);
            return wrap(Response[operation](...args));
        },
        property(id, type, name) {
            const fields = type === 'request'
                ? ['url','method','headers','bodyUsed','cache','credentials','destination','integrity','keepalive','mode','redirect','referrer','referrerPolicy','duplex']
                : ['url','status','statusText','ok','redirected','type','headers','bodyUsed'];
            if (!fields.includes(name)) throw new TypeError('Invalid body property');
            return wrap(get(id,type)[name]);
        },
        clone(id, type) { if (!['request','response'].includes(type)) throw new TypeError('Invalid clone'); return wrap(get(id,type).clone()); },
        consume,
        hasBody(id,type) { return !!get(id,type).body; },
        streamOpen(id,type) {
            const value=get(id,type);const stream=type==='blob'||type==='file'?value.stream():value.body;
            if(!stream)return null;
            return put('stream',stream,()=>{if(!stream.locked)return stream.cancel()});
        },
        async streamRead(id, type) {
            const key = `${type}:${id}`;
            let state = readers.get(key);
            if (!state) {
                const value = get(id,type);
                const stream = type === 'stream' ? value : value.body;
                if (!stream) return { done:true };
                const reader = stream.getReader();
                const resource = put('stream-reader', reader, () => reader.cancel());
                state = { reader, resource, bytes:0 }; readers.set(key,state);
            }
            try {
                const item = await state.reader.read();
                if (!item.done) { state.bytes += item.value.byteLength; if (state.bytes > maxBodyBytes) throw new RangeError('Body size limit exceeded'); }
                if (item.done) { state.reader.releaseLock(); drop(state.resource); readers.delete(key); }
                return item;
            } catch(error) { await state.reader.cancel().catch(()=>{}); state.reader.releaseLock(); drop(state.resource); readers.delete(key); throw error; }
        },
        async streamCancel(id,type,reason) {
            const key=`${type}:${id}`; const state=readers.get(key);
            if (state) { await state.reader.cancel(reason); state.reader.releaseLock(); drop(state.resource); readers.delete(key); }
            else { const value=get(id,type); const stream=type==='stream'?value:value.body; if(stream&&!stream.locked)await stream.cancel(reason); }
        },
        uploadNew() {
            const stream = new TransformStream(); const writer=stream.writable.getWriter();
            return put('upload', {stream,writer}, () => writer.abort(new Error('Script ended')));
        },
        uploadWrite(id, chunk) { if (!(chunk instanceof Uint8Array)) throw new TypeError('Upload requires Uint8Array chunks'); return get(id,'upload').writer.write(chunk); },
        uploadClose(id) { return get(id,'upload').writer.close(); },
        uploadAbort(id, reason) { return get(id,'upload').writer.abort(reason); },
        abortRequest(id) { requestControllers.get(id)?.abort(); },
        async fetch(id) {
            const request=get(id,'request');
            return wrap(await fetchImpl(request, { signal: AbortSignal.any([lifetime,request.signal]) }));
        },
    };
}
