import { Buffer } from 'node:buffer';
import * as mmdb from 'mmdb-lib';
import { warn } from '../logger.js';

const SOURCES = [
    ['Country.mmdb', 'MMDB_COUNTRY_URL'],
    ['Country-asn.mmdb', 'MMDB_ASN_URL'],
];
const MAX_BYTES = 64 * 1024 * 1024;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;

async function hashSource(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createConfiguredMmdbGateway({ gateway, env }) {
    const nextChecks = new Map();

    async function refresh(name, url, metadata) {
        if (!url) return;
        const source = await hashSource(url);
        const next = nextChecks.get(name);
        if (next?.source === source && Date.now() < next.at) return;
        const previous = metadata.find((entry) => entry.name === name);
        const sameSource = previous?.sourceUrl === source;
        try {
            const headers = {};
            if (sameSource && previous.etag) headers['If-None-Match'] = previous.etag;
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            if (response.status === 304 && sameSource) {
                nextChecks.set(name, { source, at: Date.now() + REFRESH_INTERVAL_MS });
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentLength = Number(response.headers.get('Content-Length'));
            if (contentLength > MAX_BYTES) throw new Error('MMDB too large');
            const buffer = await response.arrayBuffer();
            if (!buffer.byteLength || buffer.byteLength > MAX_BYTES) throw new Error('Invalid MMDB size');
            const reader = new mmdb.Reader(Buffer.from(buffer));
            const epochMs = reader.metadata.buildEpoch?.getTime();
            await gateway.putMmdbFile({
                name, data: new Uint8Array(buffer), etag: response.headers.get('ETag') || '', sourceUrl: source,
                buildEpoch: Number.isFinite(epochMs) ? Math.floor(epochMs / 1000) : null,
                updatedAt: Math.max(Date.now(), Number(previous?.updatedAt || 0) + 1),
            });
            nextChecks.set(name, { source, at: Date.now() + REFRESH_INTERVAL_MS });
        } catch {
            nextChecks.set(name, { source, at: Date.now() + RETRY_INTERVAL_MS });
            warn(`[GeoIP] MMDB refresh failed for ${name}`);
        }
    }

    return {
        async getMmdbMeta() {
            const metadata = await gateway.getMmdbMeta();
            for (const [name, key] of SOURCES) await refresh(name, env?.[key], metadata);
            return await gateway.getMmdbMeta();
        },
        async getMmdbFile(name) { return await gateway.getMmdbFile(name); },
        async putMmdbFile(args) { return await gateway.putMmdbFile(args); },
    };
}
