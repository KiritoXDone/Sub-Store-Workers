(() => {
    const oldKind=globalThis.__bridgeKind__, oldNeeds=globalThis.__bridgeNeedsConversion__;
    globalThis.__bridgeKind__=value=>value instanceof Date?'date':value instanceof RegExp?'regexp':value instanceof Map?'map':value instanceof Set?'set':value instanceof Error?'error':oldKind(value);
    globalThis.__bridgeRichData__=value=>{
        if(value instanceof Date)return value.getTime();
        if(value instanceof RegExp)return [value.source,value.flags,value.lastIndex];
        if(value instanceof Map)return Array.from(value.entries());
        if(value instanceof Set)return Array.from(value.values());
        if(value instanceof Error)return {name:value.name,message:value.message,stack:value.stack};
        if(ArrayBuffer.isView(value))return {name:globalThis.__sandboxBuffer__?.isBuffer(value)?'Buffer':value.constructor.name,buffer:value.buffer,byteOffset:value.byteOffset,byteLength:value.byteLength,length:value.length};
    };
    globalThis.__bridgeCreateRich__=(kind,data)=>kind==='date'?new Date(data):kind==='regexp'?new RegExp(data[0],data[1]):kind==='map'?new Map():kind==='set'?new Set():Object.assign(new Error(data.message),data);
    globalThis.__bridgeMapSet__=(map,key,value)=>map.set(key,value);
    globalThis.__bridgeSetAdd__=(set,value)=>set.add(value);
    globalThis.__bridgeMakeView__=(buffer,type,offset=0,length)=>{
        if(type==='Buffer')return __sandboxBuffer__.from(buffer,offset,length);
        return new globalThis[type](buffer,offset,length);
    };
    globalThis.__bridgeNeedsConversion__=value=>{
        const seen=new WeakSet();
        function visit(item){
            if(typeof item==='function'||typeof item==='undefined'||typeof item==='bigint')return true;
            if(typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0)))return true;
            if(!item||typeof item!=='object')return false;
            if(item instanceof Date||item instanceof RegExp||item instanceof Map||item instanceof Set||item instanceof Error||item instanceof ArrayBuffer||ArrayBuffer.isView(item))return true;
            if(seen.has(item))return true;
            seen.add(item);
            if(Array.isArray(item)){for(let i=0;i<item.length;i++)if(!(i in item))return true;}
            return Object.keys(item).some(key=>visit(item[key]));
        }
        return visit(value);
    };
    // Installed after the stream ponyfill so its transfer fallback remains intact.
    globalThis.__installStructuredClone__=()=>{
        globalThis.structuredClone=(value,options={})=>{
            if(options.transfer?.length)throw new DOMException('Transfer lists are not supported','DataCloneError');
            const seen=new Map();
            function clone(item){
                if(typeof item==='function'||typeof item==='symbol')throw new DOMException('Value cannot be cloned','DataCloneError');
                if(!item||typeof item!=='object')return item;
                if(seen.has(item))return seen.get(item);
                let result;
                if(item instanceof Date)result=new Date(item.getTime());
                else if(item instanceof RegExp)result=new RegExp(item.source,item.flags);
                else if(item instanceof ArrayBuffer)result=item.slice(0);
                else if(ArrayBuffer.isView(item))result=new item.constructor(clone(item.buffer),item.byteOffset,item instanceof DataView?item.byteLength:item.length);
                else if(item instanceof Map)result=new Map();
                else if(item instanceof Set)result=new Set();
                else if(item instanceof Error)result=Object.assign(new Error(item.message),{name:item.name,stack:item.stack});
                else if(Array.isArray(item))result=[];
                else if(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)result={};
                else throw new DOMException('Unsupported object type','DataCloneError');
                seen.set(item,result);
                if(item instanceof Map)for(const[key,value]of item)result.set(clone(key),clone(value));
                else if(item instanceof Set)for(const value of item)result.add(clone(value));
                else if(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)for(const key of Object.keys(item))Object.defineProperty(result,key,{value:clone(item[key]),enumerable:true,writable:true,configurable:true});
                return result;
            }
            return clone(value);
        };
    };
})();
