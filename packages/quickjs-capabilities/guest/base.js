
const _timers=new Map(); let _timerId=0;
function setTimeout(callback,ms=0,...args){const id=++_timerId;_timers.set(id,true);__hostCall('extras.wait',[Math.max(0,Number(ms)||0)]).then(()=>{if(_timers.delete(id))callback(...args)});return id}
function clearTimeout(id){_timers.delete(id)}
function setInterval(callback,ms=0,...args){const id=++_timerId;_timers.set(id,true);const tick=()=>__hostCall('extras.wait',[Math.max(1,Number(ms)||0)]).then(()=>{if(_timers.has(id)){callback(...args);if(_timers.has(id))tick()}});tick();return id}
function clearInterval(id){_timers.delete(id)}
globalThis.setTimeout=setTimeout;globalThis.clearTimeout=clearTimeout;globalThis.setInterval=setInterval;globalThis.clearInterval=clearInterval;
class URLSearchParams {
 constructor(init='',owner=null){this._owner=owner;this._text=__hostCall('extras.paramsInit',[init instanceof URLSearchParams?init.toString():init])}
 _op(op,args=[]){const result=__hostCall('extras.params',[this._owner?this._owner.search:this._text,op,args]);this._text=result.text;if(this._owner&&['set','append','delete','sort'].includes(op))this._owner.search=result.text;return result.value}
 get(k){return this._op('get',[k])}getAll(k){return this._op('getAll',[k])}has(...args){return this._op('has',args)}set(k,v){this._op('set',[k,v])}append(k,v){this._op('append',[k,v])}delete(...args){this._op('delete',args)}sort(){this._op('sort')}
 toString(){return this._owner?this._owner.search.replace(/^\?/,''):this._text}entries(){return this._op('entries')[Symbol.iterator]()}keys(){return this._op('keys')[Symbol.iterator]()}values(){return this._op('values')[Symbol.iterator]()}[Symbol.iterator](){return this.entries()}forEach(fn,thisArg){for(const[k,v]of this)fn.call(thisArg,v,k,this)}get size(){return [...this].length}
}
class URL {
 constructor(input,base){this._href=__hostCall('extras.urlInit',[String(input),base===undefined?undefined:String(base)]);this._params=new URLSearchParams('',this)}
 get searchParams(){return this._params}toString(){return this.href}toJSON(){return this.href}
 static canParse(input,base){try{new URL(input,base);return true}catch{return false}}
}
for(const key of ['href','origin','protocol','username','password','host','hostname','port','pathname','search','hash'])Object.defineProperty(URL.prototype,key,{get(){return __hostCall('extras.urlGet',[this._href,key])},set(value){this._href=__hostCall('extras.urlSet',[this._href,key,String(value)])}});
globalThis.URL=URL;globalThis.URLSearchParams=URLSearchParams;
