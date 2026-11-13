export function createPrimitives(signal) {
    return {
        wait(milliseconds) {
            return new Promise((resolve,reject)=>{
                const abort=()=>{clearTimeout(timer);reject(new Error('Script execution has ended'))};
                const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},Math.min(Math.max(Number(milliseconds)||0,0),2147483647));
                signal.addEventListener('abort',abort,{once:true});
                if(signal.aborted)abort();
            });
        },
        paramsInit:value=>new URLSearchParams(value).toString(),
        params(raw,operation,args) {
            if(!['get','getAll','has','set','append','delete','sort','entries','keys','values'].includes(operation))throw new TypeError('Unsupported query parameter operation');
            const params=new URLSearchParams(raw);let value=params[operation](...args);
            if(['entries','keys','values'].includes(operation))value=Array.from(value);
            return {text:params.toString(),value};
        },
        urlInit:(input,base)=>new URL(input,base).href,
        urlGet:(href,key)=>new URL(href)[key],
        urlSet(href,key,value){const url=new URL(href);url[key]=value;return url.href},
        uuid:()=>crypto.randomUUID(),
        random:length=>crypto.getRandomValues(new Uint8Array(length)),
    };
}
