(() => {
    class EventEmitter {
        constructor(){this._events=new Map();this._max=10}
        on(name,fn){if(typeof fn!=='function')throw new TypeError('Listener must be a function');const list=this._events.get(name)||[];list.push(fn);this._events.set(name,list);return this}
        addListener(name,fn){return this.on(name,fn)}
        once(name,fn){const wrap=(...args)=>{this.off(name,wrap);return fn.apply(this,args)};wrap.listener=fn;return this.on(name,wrap)}
        prependListener(name,fn){this.on(name,fn);const list=this._events.get(name);list.unshift(list.pop());return this}
        removeListener(name,fn){return this.off(name,fn)}
        off(name,fn){const list=this._events.get(name)||[];const index=list.findLastIndex(item=>item===fn||item.listener===fn);if(index>=0)list.splice(index,1);if(!list.length)this._events.delete(name);return this}
        removeAllListeners(name){if(arguments.length)this._events.delete(name);else this._events.clear();return this}
        emit(name,...args){const list=this._events.get(name);if(!list?.length){if(name==='error')throw args[0] instanceof Error?args[0]:new Error(String(args[0]));return false}for(const fn of [...list])fn.apply(this,args);return true}
        listeners(name){return (this._events.get(name)||[]).map(fn=>fn.listener||fn)}rawListeners(name){return [...(this._events.get(name)||[])]}
        listenerCount(name){return (this._events.get(name)||[]).length}eventNames(){return [...this._events.keys()]}
        setMaxListeners(value){if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid listener limit');this._max=value;return this}getMaxListeners(){return this._max}
    }
    EventEmitter.EventEmitter=EventEmitter;
    const cryptoModule={webcrypto:crypto,subtle:crypto.subtle,randomUUID:()=>crypto.randomUUID(),getRandomValues:value=>crypto.getRandomValues(value)};
    class Hash {
        constructor(id){this._id=id}
        update(data,encoding='utf8'){__hostCall('cryptoApi.hashUpdate',[this._id,typeof data==='string'?Buffer.from(data,encoding):data]);return this}
        digest(encoding){const data=Buffer.from(__hostCall('cryptoApi.hashDigest',[this._id]));return encoding?data.toString(encoding):data}
        copy(){return new Hash(__hostCall('cryptoApi.hashCopy',[this._id]))}
    }
    cryptoModule.createHash=algorithm=>new Hash(__hostCall('cryptoApi.hashNew',[algorithm,null]));
    cryptoModule.createHmac=(algorithm,key)=>new Hash(__hostCall('cryptoApi.hashNew',[algorithm,typeof key==='string'?Buffer.from(key):key]));
    cryptoModule.timingSafeEqual=(a,b)=>__hostCall('cryptoApi.timingSafeEqual',[a,b]);
    cryptoModule.randomBytes=size=>Buffer.from(__hostCall('cryptoApi.randomBytes',[size]));
    const builtins={
        lodash:__sandboxLodash__,buffer:{Buffer:__sandboxBuffer__},url:{URL,URLSearchParams},crypto:cryptoModule,events:EventEmitter,
        'stream/web':{ReadableStream,WritableStream,TransformStream,TextEncoderStream,TextDecoderStream},
    };
    const cache=new Map();
    globalThis.__sandboxModules__=builtins;
    globalThis.require=name=>{
        const key=String(name).replace(/^node:/,'');
        if(Object.prototype.hasOwnProperty.call(builtins,key))return builtins[key];
        const sources=globalThis.__commonjsModules__||{};
        if(!Object.prototype.hasOwnProperty.call(sources,key))throw new Error('Module not available in sandbox: '+key);
        if(cache.has(key))return cache.get(key).exports;
        const module={exports:{}};cache.set(key,module);
        try{new Function('module','exports','require',sources[key])(module,module.exports,require)}catch(error){cache.delete(key);throw error}
        return module.exports;
    };
})();
