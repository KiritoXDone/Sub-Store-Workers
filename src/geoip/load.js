/** Load MMDB readers from the runtime gateway, and refresh when their metadata changes. */
import { Buffer } from 'node:buffer';
import * as mmdb from 'mmdb-lib';
import { debug, warn, error as logError } from '../logger.js';

const NAMES = ['Country.mmdb', 'Country-asn.mmdb'];
const CHECK_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 5_000;

function getGlobalCache() {
    if (!globalThis.__surge_geoip_cache__) {
        globalThis.__surge_geoip_cache__ = {
            readyPromise: null,
            countryReader: null,
            asnReader: null,
            loggedMissing: false,
            version: null,
            nextCheckAt: 0,
        };
    }
    return globalThis.__surge_geoip_cache__;
}

function metadataVersion(files) {
    const entries = NAMES.map((name) => files?.find((file) => file.name === name));
    if (entries.some((file) => !file)) return null;
    return JSON.stringify(entries.map(({ etag, updatedAt, size, buildEpoch }) => [etag, updatedAt, size, buildEpoch]));
}

function bufferForFile(file) {
    const data = file?.arrayBuffer || file?.data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

export async function ensureGeoDbLoaded(env, { requestId = 'unknown' } = {}) {
    const cache = getGlobalCache();
    if (cache.readyPromise) {
        await cache.readyPromise;
        return cache;
    }
    if (Date.now() < (cache.nextCheckAt || 0)) return cache;

    const promise = (async () => {
        try {
            const gateway = env?.__mmdbGateway;
            if (!gateway) throw new Error('runtime mmdb gateway not available');

            const metadata = await gateway.getMmdbMeta();
            const version = metadataVersion(metadata);
            if (!version) throw new Error('MMDB files not found in runtime storage');
            if (cache.countryReader && cache.asnReader && cache.version === version) {
                cache.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
                return;
            }

            const files = await Promise.all(NAMES.map((name) => gateway.getMmdbFile(name)));
            const buffers = files.map(bufferForFile);
            if (buffers.some((buffer) => !buffer)) throw new Error('MMDB file data not available');
            for (let i = 0; i < NAMES.length; i += 1) {
                const meta = metadata.find((file) => file.name === NAMES[i]);
                if ((files[i].updatedAt != null && String(files[i].updatedAt) !== String(meta.updatedAt)) ||
                    (files[i].etag != null && String(files[i].etag) !== String(meta.etag ?? ''))) {
                    throw new Error('MMDB changed while loading');
                }
            }

            // Publish both readers together only after both files have been validated.
            const countryReader = new mmdb.Reader(buffers[0]);
            const asnReader = new mmdb.Reader(buffers[1]);
            cache.countryReader = countryReader;
            cache.asnReader = asnReader;
            cache.version = version;
            cache.loggedMissing = false;
            cache.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
            debug(`[GeoIP] [${requestId}] mmdb readers initialized`);
        } catch (err) {
            cache.nextCheckAt = Date.now() + RETRY_INTERVAL_MS;
            if (!cache.loggedMissing) {
                cache.loggedMissing = true;
                if (cache.countryReader && cache.asnReader) {
                    warn('[GeoIP] MMDB refresh failed; retaining previous readers');
                } else {
                    logError('[GeoIP] failed to load MMDB from runtime storage:', err?.stack || err?.message || err);
                }
            }
        }
    })();

    cache.readyPromise = promise;
    try {
        await promise;
    } finally {
        if (cache.readyPromise === promise) cache.readyPromise = null;
    }
    return cache;
}
