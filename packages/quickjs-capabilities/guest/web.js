(() => {
    const records=new WeakMap(), objects=new Map(), bodies=new WeakMap(), signals=new WeakMap();
    const host=(method,...args)=>__hostCall('web.'+method,args);
    const record=value=>{const result=records.get(value);if(!result)throw new TypeError('Invalid Web API receiver');return result};
    const isBody=value=>value instanceof Request||value instanceof Response;
    function wrap(info) {
        if(!info||typeof info!=='object'||!info.id||!info.type)return info;
        if(objects.has(info.id))return objects.get(info.id);
        const cls={headers:Headers,blob:Blob,file:File,form:FormData,request:Request,response:Response}[info.type];
        if(!cls)return info;
        const value=Object.create(cls.prototype);
        records.set(value,info);objects.set(info.id,value);return value;
    }
    function headerInit(value) {return value instanceof Headers?{__headers:true,id:record(value).id}:value}
    function encodeBody(value) {
        if(value instanceof Blob||value instanceof FormData){const info=record(value);return {__body:info.type,id:info.id}}
        if(value instanceof URLSearchParams)return {__body:'params',text:value.toString()};
        if(value instanceof ReadableStream) {
            const id=host('uploadNew');
            const reader=value.getReader();
            (async()=>{
                try {while(true){const item=await reader.read();if(item.done)break;await host('uploadWrite',id,item.value)}await host('uploadClose',id)}
                catch(error){await host('uploadAbort',id,String(error)).catch(()=>{});await reader.cancel(error).catch(()=>{})}
                finally{reader.releaseLock()}
            })();
            return {__body:'upload',id};
        }
        return value;
    }
    function initOptions(init={}) {const out={...init};if('headers'in out)out.headers=headerInit(out.headers);if('body'in out)out.body=encodeBody(out.body);delete out.signal;return out}
    function getBody(value) {
        if(bodies.has(value))return bodies.get(value);
        const info=record(value);const streamId=host('streamOpen',info.id,info.type);
        const stream=streamId===null?null:new ReadableStream({
            async pull(controller) {
                try {const item=await host('streamRead',streamId,'stream');if(item.done)controller.close();else controller.enqueue(item.value)}
                catch(error){controller.error(signals.get(value)?.aborted?signals.get(value).reason:error)}
            },
            cancel(reason){return host('streamCancel',streamId,'stream',String(reason??''))},
        },{highWaterMark:0});
        bodies.set(value,stream);return stream;
    }
    function checkUnlocked(value) {if(bodies.get(value)?.locked)throw new TypeError('Body is locked')}
    async function consume(value,mode) {checkUnlocked(value);const info=record(value);try{return wrap(await host('consume',info.id,info.type,mode))}catch(error){if(signals.get(value)?.aborted)throw signals.get(value).reason;throw error}}
    function installBodyMethods(cls) {
        for(const mode of ['text','json','arrayBuffer','bytes','blob','formData'])Object.defineProperty(cls.prototype,mode,{value:function(){return consume(this,mode)}});
        Object.defineProperty(cls.prototype,'body',{get(){return getBody(this)}});
    }
    class Headers {
        constructor(init){return wrap(host('headersNew',headerInit(init)))}
        _op(method,...args){return host('headers',record(this).id,method,args)}
        get(key){return this._op('get',key)}getSetCookie(){return this._op('getSetCookie')}has(key){return this._op('has',key)}
        set(key,value){this._op('set',key,value)}append(key,value){this._op('append',key,value)}delete(key){this._op('delete',key)}
        entries(){return this._op('entries')[Symbol.iterator]()}keys(){return this._op('keys')[Symbol.iterator]()}values(){return this._op('values')[Symbol.iterator]()}[Symbol.iterator](){return this.entries()}
        forEach(callback,thisArg){for(const[key,value]of this)callback.call(thisArg,value,key,this)}
    }
    class Blob {
        constructor(parts=[],options={}){return wrap(host('blobNew',Array.from(parts,encodeBody),options,null))}
        get size(){return record(this).size}get type(){return record(this).mime}
        slice(start,end,type){const info=record(this);return wrap(host('blobSlice',info.id,info.type,start,end,type))}
        text(){const info=record(this);return host('blobRead',info.id,info.type,'text')}arrayBuffer(){const info=record(this);return host('blobRead',info.id,info.type,'arrayBuffer')}
        bytes(){const info=record(this);return host('blobRead',info.id,info.type,'bytes')}
        stream(){const info=record(this);bodies.delete(this);return getBody(this)}
    }
    class File extends Blob {
        constructor(parts,name,options={}){return wrap(host('blobNew',Array.from(parts,encodeBody),options,{name:String(name),lastModified:options.lastModified}))}
        get name(){return record(this).name}get lastModified(){return record(this).lastModified}
    }
    class FormData {
        constructor(){return wrap(host('formNew'))}
        _op(method,...args){return host('form',record(this).id,method,args)}
        append(name,value,filename){const args=[name,encodeBody(value)];if(filename!==undefined)args.push(filename);this._op('append',...args)}
        set(name,value,filename){const args=[name,encodeBody(value)];if(filename!==undefined)args.push(filename);this._op('set',...args)}
        get(name){return wrap(this._op('get',name))}getAll(name){return this._op('getAll',name).map(wrap)}has(name){return this._op('has',name)}delete(name){this._op('delete',name)}
        entries(){return this._op('entries').map(([key,value])=>[key,wrap(value)])[Symbol.iterator]()}keys(){return this._op('keys')[Symbol.iterator]()}values(){return this._op('values').map(wrap)[Symbol.iterator]()}[Symbol.iterator](){return this.entries()}
        forEach(callback,thisArg){for(const[key,value]of this)callback.call(thisArg,value,key,this)}
    }
    function attachSignal(value, source) {
        const signal=source?AbortSignal.any([source]):new AbortController().signal;
        signals.set(value,signal);const cancel=()=>host('abortRequest',record(value).id);
        if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
        return value;
    }
    class Request {
        constructor(input,init={}) {
            if(input instanceof Request&&!('body'in init))checkUnlocked(input);
            const source=init.signal===undefined?(input instanceof Request?input.signal:undefined):init.signal;
            if(source!=null&&!(source instanceof AbortSignal))throw new TypeError('Expected AbortSignal');
            const value=wrap(host('requestNew',input instanceof Request?{__request:true,id:record(input).id}:String(input),initOptions(init)));
            return attachSignal(value,source);
        }
        get signal(){return signals.get(this)}
        clone(){checkUnlocked(this);return attachSignal(wrap(host('clone',record(this).id,'request')),this.signal)}
    }
    class Response {
        constructor(body=null,init={}){return wrap(host('responseNew',encodeBody(body),initOptions(init)))}
        clone(){checkUnlocked(this);const result=wrap(host('clone',record(this).id,'response'));if(signals.has(this))signals.set(result,signals.get(this));return result}
        static json(value,init){return wrap(host('responseStatic','json',[value,initOptions(init)]))}
        static redirect(url,status){return wrap(host('responseStatic','redirect',[String(url),status]))}
        static error(){return wrap(host('responseStatic','error',[]))}
    }
    for(const[cls,type,fields]of [
        [Request,'request',['url','method','headers','bodyUsed','cache','credentials','destination','integrity','keepalive','mode','redirect','referrer','referrerPolicy','duplex']],
        [Response,'response',['url','status','statusText','ok','redirected','type','headers','bodyUsed']],
    ]) {
        for(const field of fields)Object.defineProperty(cls.prototype,field,{get(){return wrap(host('property',record(this).id,type,field))}});
        installBodyMethods(cls);
    }
    globalThis.Headers=Headers;globalThis.Blob=Blob;globalThis.File=File;globalThis.FormData=FormData;globalThis.Request=Request;globalThis.Response=Response;
    globalThis.fetch=async(input,init)=>{
        const request=new Request(input,init);request.signal.throwIfAborted();
        try{const response=wrap(await host('fetch',record(request).id));signals.set(response,request.signal);return response}
        catch(error){if(request.signal.aborted)throw request.signal.reason;throw new TypeError(String(error))}
    };
    globalThis.TextEncoderStream=class {
        constructor(){const encoder=new TextEncoder();this._stream=new TransformStream({transform(value,controller){controller.enqueue(encoder.encode(value))}})}
        get encoding(){return'utf-8'}get readable(){return this._stream.readable}get writable(){return this._stream.writable}
    };
    globalThis.TextDecoderStream=class {
        constructor(label='utf-8',options={}){const decoder=new TextDecoder(label,options);this.encoding=decoder.encoding;this.fatal=decoder.fatal;this.ignoreBOM=decoder.ignoreBOM;this._stream=new TransformStream({transform(value,controller){const text=decoder.decode(value,{stream:true});if(text)controller.enqueue(text)},flush(controller){const text=decoder.decode();if(text)controller.enqueue(text)}})}
        get readable(){return this._stream.readable}get writable(){return this._stream.writable}
    };
})();
