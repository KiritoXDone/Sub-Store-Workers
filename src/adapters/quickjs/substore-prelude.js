// Code evaluated inside each isolated QuickJS context.
export const SUBSTORE_PRELUDE = String.raw`
function __makeHostProxy(prefix) {
  const fn = function(...args) { return __hostCall(prefix, args); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toStringTag) return 'HostProxy';
      if (prop === 'toJSON') return () => '[HostProxy ' + prefix + ']';
      return __makeHostProxy(prefix + '.' + String(prop));
    },
    apply(_t, _thisArg, args) { return __hostCall(prefix, args); }
  });
}
globalThis.__makeHostProxy__ = __makeHostProxy;

// Text codecs run in the host, whose Web APIs are available in Workers and Deno.
class TextEncoderPolyfill {
  get encoding() { return 'utf-8'; }
  encode(input = '') { return __hostCall('textCodec.encode', [String(input)]); }
  encodeInto(input, destination) {
    const bytes = this.encode(input);
    let written = Math.min(bytes.length, destination.length);
    while (written < bytes.length && written > 0 && (bytes[written] & 0xc0) === 0x80) written--;
    destination.set(bytes.subarray(0, written));
    return { read: __hostCall('textCodec.decodeUtf8', [bytes.subarray(0, written)]).length, written };
  }
}
class TextDecoderPolyfill {
  constructor(label = 'utf-8', options = {}) {
    const info = __hostCall('textCodec.createDecoder', [label, options]);
    this._id = info.id;
    this.encoding = info.encoding;
    this.fatal = info.fatal;
    this.ignoreBOM = info.ignoreBOM;
  }
  decode(input = new Uint8Array(), options = {}) {
    let bytes;
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('Expected an ArrayBuffer or ArrayBuffer view');
    return __hostCall('textCodec.decode', [this._id, bytes, options]);
  }
}
globalThis.TextEncoder = TextEncoderPolyfill;
globalThis.TextDecoder = TextDecoderPolyfill;

const __b64chars__ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __b64Encode__(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += __b64chars__[(n >> 18) & 63] + __b64chars__[(n >> 12) & 63]
      + (i + 1 < bytes.length ? __b64chars__[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? __b64chars__[n & 63] : '=');
  }
  return out;
}
function __b64Decode__(value) {
  const clean = String(value).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '').split('=')[0];
  const bytes = [];
  let bits = 0, n = 0;
  for (const ch of clean) {
    n = (n << 6) | __b64chars__.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((n >> bits) & 255); }
  }
  return Uint8Array.from(bytes);
}
function __encoding__(encoding) {
  const value = String(encoding || 'utf8').toLowerCase();
  if (value === 'utf8' || value === 'utf-8') return 'utf8';
  if (value === 'base64' || value === 'base64url' || value === 'hex' || value === 'latin1' || value === 'binary' || value === 'ascii') return value;
  throw new TypeError('Unknown encoding: ' + encoding);
}
class BufferPolyfill extends Uint8Array {
  static from(input, encodingOrOffset, length) {
    if (typeof input === 'string') {
      const enc = __encoding__(encodingOrOffset);
      let bytes;
      if (enc === 'base64' || enc === 'base64url') bytes = __b64Decode__(input);
      else if (enc === 'hex') {
        const result = [];
        for (let i = 0; i + 1 < input.length; i += 2) {
          const pair = input.slice(i, i + 2);
          if (!/^[0-9a-f]{2}$/i.test(pair)) break;
          result.push(parseInt(pair, 16));
        }
        bytes = Uint8Array.from(result);
      } else if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') bytes = Uint8Array.from(input, ch => ch.charCodeAt(0) & 255);
      else bytes = new TextEncoderPolyfill().encode(input);
      return new BufferPolyfill(bytes);
    }
    if (input instanceof ArrayBuffer) return new BufferPolyfill(input, encodingOrOffset || 0, length);
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) input = input.data;
    if (input == null || typeof input === 'number') throw new TypeError('Invalid Buffer input');
    return new BufferPolyfill(input);
  }
  static alloc(size, fill = 0) { return new BufferPolyfill(size).fill(fill); }
  static isBuffer(value) { return value instanceof BufferPolyfill; }
  static concat(list, totalLength = list.reduce((sum, item) => sum + item.length, 0)) {
    const result = new BufferPolyfill(totalLength);
    let offset = 0;
    for (const item of list) { const bytes = item.subarray(0, totalLength - offset); result.set(bytes, offset); offset += bytes.length; if (offset >= totalLength) break; }
    return result;
  }
  toString(encoding, start = 0, end = this.length) {
    const enc = __encoding__(encoding);
    const bytes = this.subarray(start, end);
    if (enc === 'base64' || enc === 'base64url') {
      const result = __b64Encode__(bytes);
      return enc === 'base64url' ? result.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : result;
    }
    if (enc === 'hex') return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return Array.from(bytes, b => String.fromCharCode(enc === 'ascii' ? b & 127 : b)).join('');
    return __hostCall('textCodec.decodeUtf8', [bytes]);
  }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
}
globalThis.__BufferPolyfill__ = BufferPolyfill;

// Inspect values without serializing away functions or binary data.
const __bridgeIds__ = new WeakMap();
let __nextBridgeId__ = 1;
globalThis.__bridgeKind__ = value => {
  if (value instanceof ArrayBuffer) return 'buffer';
  if (ArrayBuffer.isView(value)) return 'view';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'function' ? 'function' : value === null ? 'null' : typeof value;
};
globalThis.__bridgeId__ = value => {
  if (!__bridgeIds__.has(value)) __bridgeIds__.set(value, __nextBridgeId__++);
  return __bridgeIds__.get(value);
};
globalThis.__bridgeBytes__ = value => value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
globalThis.__bridgeDefineProtoKey__ = (object, value) => Object.defineProperty(object, '__proto__', { value, writable: true, enumerable: true, configurable: true });
globalThis.__bridgeMakeView__ = (buffer, type) => {
  const ctor = globalThis[type];
  return typeof ctor === 'function' ? new ctor(buffer) : new Uint8Array(buffer);
};
globalThis.__bridgeNeedsConversion__ = value => {
  const seen = new WeakSet();
  function visit(item) {
    if (typeof item === 'function') return true;
    if (!item || typeof item !== 'object') return false;
    if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return true;
    if (seen.has(item)) return false;
    seen.add(item);
    return Object.keys(item).some(key => visit(item[key]));
  }
  return visit(value);
};
`;
