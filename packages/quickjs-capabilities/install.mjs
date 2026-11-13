import {CAPABILITIES} from './generated.mjs';
import {createResources} from './host/resources.mjs';
import {createWebApi} from './host/web.mjs';
import {createCryptoApi} from './host/crypto.mjs';

export function createHostCapabilities(signal, options={}) {
    const resources=createResources(signal,options);
    return {resources,web:createWebApi(resources,signal,options),cryptoApi:createCryptoApi(resources)};
}
export function installGuestCapabilities(vm, runtime, options={}) {
    const install=vm.evalCode(CAPABILITIES);
    if(install.error){try{throw new Error(vm.dump(install.error)?.message||'Capability installation failed')}finally{install.error.dispose()}}
    install.value.dispose();
    const setup=vm.evalCode('globalThis.__commonjsModules__ = '+JSON.stringify(options.commonjsModules||{})+';');
    if(setup.error){const message=vm.dump(setup.error);setup.error.dispose();throw new Error(String(message))}setup.value.dispose();
    const builtins={
        lodash:['map','filter','reduce','chain','cloneDeep'],buffer:['Buffer'],url:['URL','URLSearchParams'],
        crypto:['webcrypto','subtle','randomUUID','getRandomValues','createHash','createHmac','randomBytes','timingSafeEqual'],
        events:['EventEmitter'],'stream/web':['ReadableStream','WritableStream','TransformStream','TextEncoderStream','TextDecoderStream'],
    };
    runtime.setModuleLoader(name=>{
        const key=name.replace(/^node:/,'');
        if(Object.prototype.hasOwnProperty.call(builtins,key))return `const m=globalThis.__sandboxModules__[${JSON.stringify(key)}];export default m;`+builtins[key].map(name=>`export const ${name}=m.${name};`).join('');
        if(Object.prototype.hasOwnProperty.call(options.esmModules||{},name))return options.esmModules[name];
        throw new Error('Module not available in sandbox: '+name);
    });
}
