(() => {
    const keys=new WeakMap();
    class CryptoKey {
        constructor(){throw new TypeError('Illegal constructor')}
        get type(){return keys.get(this).type}get extractable(){return keys.get(this).extractable}
        get algorithm(){return structuredClone(keys.get(this).algorithm)}get usages(){return [...keys.get(this).usages]}
    }
    const id=key=>{const value=keys.get(key);if(!value)throw new TypeError('Expected CryptoKey');return value.__cryptoKey};
    function wrap(value) {
        if(value?.__cryptoKey){const result=Object.create(CryptoKey.prototype);keys.set(result,value);return result}
        if(value?.publicKey&&value?.privateKey)return {publicKey:wrap(value.publicKey),privateKey:wrap(value.privateKey)};
        return value;
    }
    function algorithm(value){if(!value||typeof value!=='object')return value;return {...value,...(value.public?{public:{__cryptoKey:id(value.public)}}:{})}}
    const invoke=(name,...args)=>__hostCall('cryptoApi.'+name,args).then(wrap);
    globalThis.CryptoKey=CryptoKey;
    globalThis.crypto.subtle={
        generateKey:(alg,extractable,usages)=>invoke('generateKey',algorithm(alg),extractable,usages),
        importKey:(format,data,alg,extractable,usages)=>invoke('importKey',format,data,algorithm(alg),extractable,usages),
        exportKey:(format,key)=>invoke('exportKey',format,id(key)),
        encrypt:(alg,key,data)=>invoke('encrypt',algorithm(alg),id(key),data),
        decrypt:(alg,key,data)=>invoke('decrypt',algorithm(alg),id(key),data),
        sign:(alg,key,data)=>invoke('sign',algorithm(alg),id(key),data),
        verify:(alg,key,signature,data)=>invoke('verify',algorithm(alg),id(key),signature,data),
        digest:(alg,data)=>invoke('digest',algorithm(alg),data),
        deriveBits:(alg,key,length)=>invoke('deriveBits',algorithm(alg),id(key),length),
        deriveKey:(alg,key,derived,extractable,usages)=>invoke('deriveKey',algorithm(alg),id(key),algorithm(derived),extractable,usages),
        wrapKey:(format,key,wrapping,alg)=>invoke('wrapKey',format,id(key),id(wrapping),algorithm(alg)),
        unwrapKey:(format,data,unwrapping,unwrapAlg,alg,extractable,usages)=>invoke('unwrapKey',format,data,id(unwrapping),algorithm(unwrapAlg),algorithm(alg),extractable,usages),
    };
})();
