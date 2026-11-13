import { Buffer } from 'node:buffer';
function resultValue(vm, result, label) {
    if (!result.error) return result.value;
    try {
        const error = vm.dump(result.error);
        throw new Error(`${label}: ${error?.message || error}`);
    } finally {
        result.error.dispose();
    }
}

// Return a fresh owned handle. Temporary handles are released even on conversion errors.
export function nativeToQuickJsHandle(vm, value, links) {
    const seen=new Map();
    function helper(name,args) {
        const fn=vm.getProp(vm.global,name);
        try{return resultValue(vm,vm.callFunction(fn,vm.undefined,...args),'QuickJS conversion failed')}
        finally{fn.dispose()}
    }
    function rich(kind,data) {
        const k=vm.newString(kind),d=convert(data);
        try{return helper('__bridgeCreateRich__',[k,d])}finally{k.dispose();d.dispose()}
    }
    function convert(item) {
        if(item===null)return vm.null;if(item===undefined)return vm.undefined;
        if(typeof item==='string')return vm.newString(item);if(typeof item==='number')return vm.newNumber(item);
        if(typeof item==='boolean')return item?vm.true:vm.false;if(typeof item==='bigint')return vm.newBigInt(item);
        const linked=links?.get(item);if(linked?.alive)return linked.dup();
        if(typeof item!=='object')throw new TypeError('Unsupported host value: '+typeof item);
        if(seen.has(item))return seen.get(item).dup();
        let handle;
        if(item instanceof ArrayBuffer)handle=vm.newArrayBuffer(item);
        else if(ArrayBuffer.isView(item)){
            const buffer=convert(item.buffer),name=vm.newString(item.constructor.name),offset=vm.newNumber(item.byteOffset),length=vm.newNumber(item instanceof DataView?item.byteLength:item.length);
            try{handle=helper('__bridgeMakeView__',[buffer,name,offset,length])}finally{buffer.dispose();name.dispose();offset.dispose();length.dispose()}
        }else if(item instanceof Date)handle=rich('date',item.getTime());
        else if(item instanceof RegExp){handle=rich('regexp',[item.source,item.flags]);const last=vm.newNumber(item.lastIndex);vm.setProp(handle,'lastIndex',last);last.dispose()}
        else if(item instanceof Error)handle=rich('error',{name:item.name,message:item.message,stack:item.stack});
        else if(item instanceof Map)handle=rich('map',null);
        else if(item instanceof Set)handle=rich('set',null);
        else handle=Array.isArray(item)?vm.newArray():vm.newObject();
        seen.set(item,handle.dup());
        try{
            if(item instanceof Map){for(const[key,value]of item){const k=convert(key),v=convert(value);try{helper('__bridgeMapSet__',[handle,k,v]).dispose()}finally{k.dispose();v.dispose()}}}
            else if(item instanceof Set){for(const value of item){const v=convert(value);try{helper('__bridgeSetAdd__',[handle,v]).dispose()}finally{v.dispose()}}}
            else if(!(item instanceof ArrayBuffer)&&!ArrayBuffer.isView(item)&&!(item instanceof Date)&&!(item instanceof RegExp)&&!(item instanceof Error)){
                if(Array.isArray(item)){const length=vm.newNumber(item.length);vm.setProp(handle,'length',length);length.dispose()}
                for(const[key,value]of Object.entries(item)){const v=convert(value);try{if(key==='__proto__')helper('__bridgeDefineProtoKey__',[handle,v]).dispose();else vm.setProp(handle,key,v)}finally{v.dispose()}}
            }
            return handle;
        }catch(error){handle.dispose();throw error}
    }
    try{return convert(value)}finally{for(const handle of seen.values())handle.dispose()}
}

export function createQuickJsHostBridge(vm, wake) {
    let active = true;
    let failure = null;
    const pending = new Set();
    const callbacks = new Set();
    const asyncCallbacks = new Set(), retainedStates = new Set();
    const decoders = new Map();
    const abortController = new AbortController();
    let nextDecoderId = 1;

    const textCodec = {
        encode: (text) => new TextEncoder().encode(text),
        decodeUtf8: (bytes) => new TextDecoder().decode(bytes),
        createDecoder: (label, options) => {
            const decoder = new TextDecoder(label, options);
            const id = nextDecoderId++;
            decoders.set(id, decoder);
            return { id, encoding: decoder.encoding, fatal: decoder.fatal, ignoreBOM: decoder.ignoreBOM };
        },
        decode: (id, bytes, options) => {
            const decoder = decoders.get(id);
            if (!decoder) throw new Error('TextDecoder is no longer available');
            return decoder.decode(bytes, options);
        },
    };

    function callHelper(name, value) {
        const helper = vm.getProp(vm.global, name);
        try {
            return resultValue(vm, vm.callFunction(helper, vm.undefined, value), `QuickJS ${name} failed`);
        } finally {
            helper.dispose();
        }
    }

    function convertGuest(handle, state) {
        const kindHandle=callHelper('__bridgeKind__',handle);
        let kind;try{kind=vm.getString(kindHandle)}finally{kindHandle.dispose()}
        if(!['function','object','array','date','regexp','map','set','error','buffer','view'].includes(kind))return vm.dump(handle);
        const idHandle=callHelper('__bridgeId__',handle);let id;
        try{id=vm.getNumber(idHandle)}finally{idHandle.dispose()}
        if(state.seen.has(id))return state.seen.get(id);
        if(kind==='function'){
            state.keepAlive=true;
            const callback=handle.dup();callbacks.add(callback);
            const fn=(...args)=>{
                if(!active)return Promise.reject(new Error('Script execution has ended'));
                const handles=[];
                try{
                    for(const arg of args)handles.push(nativeToQuickJsHandle(vm,arg,state.links));
                    const result=resultValue(vm,vm.callFunction(callback,vm.undefined,...handles),'QuickJS callback failed');
                    try{
                        const promiseState=vm.getPromiseState(result);
                        if(promiseState.notAPromise)return convertGuest(result,state);
                        if(promiseState.type==='fulfilled')promiseState.value.dispose();
                        if(promiseState.type==='rejected')promiseState.error.dispose();
                        const promiseHandle=result.dup();let cancel;
                        const entry={handle:promiseHandle,cancel:undefined};
                        const completion=new Promise((resolve,reject)=>{
                            cancel=reject;
                            vm.resolvePromise(promiseHandle).then(outcome=>{
                                if(!active)return;
                                try{const value=resultValue(vm,outcome,'QuickJS async callback failed');try{resolve(convertGuest(value,state))}finally{value.dispose()}}
                                catch(error){reject(error)}
                            },reject);
                        });
                        entry.cancel=cancel;asyncCallbacks.add(entry);wake();
                        return completion.finally(()=>{asyncCallbacks.delete(entry);if(promiseHandle.alive)promiseHandle.dispose()});
                    }finally{result.dispose()}
                }finally{for(const item of handles)item.dispose()}
            };
            state.seen.set(id,fn);state.links.set(fn,callback);return fn;
        }
        let object;
        if(kind==='buffer'){
            const bytes=vm.getArrayBuffer(handle);
            try{object=Uint8Array.from(bytes.value).buffer}finally{bytes.dispose()}
        }else if(kind==='view'){
            const descriptor=callHelper('__bridgeRichData__',handle);let info;
            try{info=convertGuest(descriptor,state)}finally{descriptor.dispose()}
            const constructors={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,DataView,Buffer};
            const Ctor=constructors[info.name];if(!Ctor)throw new TypeError('Unsupported typed array');
            object=info.name==='Buffer'?Buffer.from(info.buffer,info.byteOffset,info.length):new Ctor(info.buffer,info.byteOffset,info.name==='DataView'?info.byteLength:info.length);
        }else if(kind==='date'||kind==='regexp'||kind==='error'){
            const data=callHelper('__bridgeRichData__',handle);let value;try{value=vm.dump(data)}finally{data.dispose()}
            object=kind==='date'?new Date(value):kind==='regexp'?new RegExp(value[0],value[1]):Object.assign(new Error(value.message),value);
            if(kind==='regexp')object.lastIndex=value[2];
        }else object=kind==='map'?new Map():kind==='set'?new Set():kind==='array'?new Array(vm.getLength(handle)||0):{};
        state.seen.set(id,object);
        if(state.open){const link=handle.dup();state.links.set(object,link);state.handles.push(link)}
        if(kind==='map'||kind==='set'){
            const data=callHelper('__bridgeRichData__',handle);
            try{const values=convertGuest(data,state);if(kind==='map')for(const[k,v]of values)object.set(k,v);else for(const value of values)object.add(value)}finally{data.dispose()}
        }else if(kind==='object'||kind==='array'){
            const keys=resultValue(vm,vm.getOwnPropertyNames(handle,{strings:true,numbersAsStrings:true,onlyEnumerable:true}),'QuickJS properties failed');
            try{for(const keyHandle of keys){const key=vm.getString(keyHandle),child=vm.getProp(handle,keyHandle);try{Object.defineProperty(object,key,{value:convertGuest(child,state),writable:true,enumerable:true,configurable:true})}finally{child.dispose()}}}finally{keys.dispose()}
        }
        return object;
    }

    function openCall(handle) {
        const state = { seen: new Map(), links: new WeakMap(), handles: [], open: true };
        try {
            const special = callHelper('__bridgeNeedsConversion__', handle);
            let value;
            try {
                value = vm.dump(special) ? convertGuest(handle, state) : vm.dump(handle);
            } finally {
                special.dispose();
            }
            return {
                value,
                links: state.links,
                close() {
                    if(state.keepAlive && active){retainedStates.add(state);return;}
                    state.open = false;
                    for (const item of state.handles) if (item.alive) item.dispose();
                    state.handles.length = 0;
                },
            };
        } catch (error) {
            state.open = false;
            for (const item of state.handles) if (item.alive) item.dispose();
            throw error;
        }
    }

    function toNative(handle) {
        const call = openCall(handle);
        try { return call.value; } finally { call.close(); }
    }

    function bridgeResult(result, errorAsObject = false, links) {
        if (!result || (typeof result !== 'object' && typeof result !== 'function') || typeof result.then !== 'function') {
            return nativeToQuickJsHandle(vm, result, links);
        }
        const deferred = vm.newPromise();
        const entry = { deferred, result };
        pending.add(entry);
        const settle = (value, rejected) => {
            if (!active) return;
            try {
                let handle;
                try {
                    handle = rejected
                        ? (errorAsObject ? vm.newError(value?.message || String(value)) : vm.newString(value?.message || String(value)))
                        : nativeToQuickJsHandle(vm, value);
                    if (rejected && errorAsObject) {
                        const name=vm.newString(value?.name || 'Error');
                        try { vm.setProp(handle,'name',name); } finally { name.dispose(); }
                    }
                    if (rejected) deferred.reject(handle);
                    else deferred.resolve(handle);
                } finally {
                    handle?.dispose();
                }
            } catch (error) {
                try {
                    const handle = vm.newError(error?.message || String(error));
                    try { deferred.reject(handle); } finally { handle.dispose(); }
                } catch (bridgeError) {
                    failure = bridgeError;
                }
            } finally {
                pending.delete(entry);
                try { if (deferred.alive) deferred.dispose(); }
                catch (error) { failure = error; }
                finally { wake(); }
            }
        };
        Promise.resolve(result).then((value) => settle(value, false), (error) => settle(error, true));
        return deferred.handle;
    }

    function close() {
        active = false;
        let failure;
        const attempt = (action) => {
            try { action(); } catch (error) { failure ||= error; }
        };
        attempt(() => abortController.abort());
        for (const { deferred, result } of pending) {
            if (typeof result.cancel === 'function') attempt(() => result.cancel());
            attempt(() => { if (deferred.alive) deferred.dispose(); });
        }
        pending.clear();
        for(const entry of asyncCallbacks){attempt(()=>entry.cancel(new Error('Script execution has ended')));attempt(()=>{if(entry.handle.alive)entry.handle.dispose()})}
        asyncCallbacks.clear();
        for(const state of retainedStates){state.open=false;for(const handle of state.handles)attempt(()=>{if(handle.alive)handle.dispose()});state.handles.length=0}
        retainedStates.clear();
        for (const handle of callbacks) attempt(() => { if (handle.alive) handle.dispose(); });
        callbacks.clear();
        decoders.clear();
        if (failure) throw failure;
    }

    return { textCodec, toNative, openCall, bridgeResult, close, signal: abortController.signal, getFailure: () => failure };
}
