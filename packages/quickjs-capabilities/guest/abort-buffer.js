
const SandboxBuffer = globalThis.__sandboxBuffer__;
const bufferFrom = SandboxBuffer.from;
const byteLength = SandboxBuffer.byteLength;
const isEncoding = SandboxBuffer.isEncoding;
const bufferToString = SandboxBuffer.prototype.toString;
const bufferWrite = SandboxBuffer.prototype.write;
const urlEncoding = encoding => typeof encoding === 'string' && encoding.toLowerCase() === 'base64url';
SandboxBuffer.from = function(value, encoding, length) {
  return bufferFrom.call(this, value, urlEncoding(encoding) ? 'base64' : encoding, length);
};
SandboxBuffer.byteLength = function(value, encoding, ...rest) {
  return byteLength.call(this, value, urlEncoding(encoding) ? 'base64' : encoding, ...rest);
};
SandboxBuffer.isEncoding = encoding => urlEncoding(encoding) || isEncoding(encoding);
SandboxBuffer.prototype.toString = function(encoding, start, end) {
  const result = bufferToString.call(this, urlEncoding(encoding) ? 'base64' : encoding, start, end);
  return urlEncoding(encoding) ? result.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : result;
};
SandboxBuffer.prototype.write = function(value, ...args) {
  return bufferWrite.call(this, value, ...args.map(arg => urlEncoding(arg) ? 'base64' : arg));
};

class DOMException extends Error {
  constructor(message='', name='Error') { super(message); this.name=name; this.code=name==='AbortError'?20:name==='TimeoutError'?23:0; }
}
class AbortSignal {
  constructor() { this.aborted=false; this.reason=undefined; this.onabort=null; this._listeners=new Map(); }
  addEventListener(type, callback, options={}) {
    if(type!=='abort'||!callback||this._listeners.has(callback))return;
    this._listeners.set(callback,{once:!!options?.once});
  }
  removeEventListener(type, callback) { if(type==='abort')this._listeners.delete(callback); }
  throwIfAborted() { if(this.aborted)throw this.reason; }
  _abort(reason) {
    if(this.aborted)return;
    this.aborted=true;this.reason=reason===undefined?new DOMException('This operation was aborted','AbortError'):reason;
    const event={type:'abort',target:this,currentTarget:this};
    const callbacks=[...this._listeners.entries()];
    if(typeof this.onabort==='function')callbacks.push([this.onabort,{once:false}]);
    for(const [callback,options] of callbacks) {
      if(options.once)this._listeners.delete(callback);
      try { if(typeof callback==='function')callback.call(this,event);else callback.handleEvent?.(event); }
      catch(error) { console.error(error); }
    }
  }
  static abort(reason) { const signal=new AbortSignal();signal._abort(reason);return signal; }
  static timeout(ms) {
    if(!Number.isSafeInteger(ms)||ms<0||ms>4294967295)throw new RangeError('Invalid timeout');
    const signal=new AbortSignal();
    setTimeout(()=>signal._abort(new DOMException('The operation timed out','TimeoutError')),ms);
    return signal;
  }
  static any(signals) {
    const inputs=Array.from(signals);
    if(inputs.some(signal=>!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');
    const output=new AbortSignal();const listeners=[];
    const abort=signal=>{output._abort(signal.reason);for(const [source,fn]of listeners)source.removeEventListener('abort',fn)};
    for(const signal of inputs) {
      if(signal.aborted){abort(signal);break;}
      const fn=()=>abort(signal);listeners.push([signal,fn]);signal.addEventListener('abort',fn,{once:true});
    }
    return output;
  }
}
class AbortController {
  constructor(){Object.defineProperty(this,'signal',{value:new AbortSignal(),enumerable:true})}
  abort(reason){this.signal._abort(reason)}
}
globalThis.DOMException=DOMException;
globalThis.AbortSignal=AbortSignal;
globalThis.AbortController=AbortController;
