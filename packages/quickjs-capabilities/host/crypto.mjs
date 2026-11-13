import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
export function createCryptoApi(resources, subtle = globalThis.crypto.subtle) {
    const { put, get } = resources;
    const key = id => get(id, 'crypto-key');
    function wrap(value) {
        if (value?.constructor?.name === 'CryptoKey') {
            return { __cryptoKey: put('crypto-key', value), type: value.type, extractable: value.extractable, algorithm: value.algorithm, usages: value.usages };
        }
        if (value?.publicKey && value?.privateKey) return { publicKey:wrap(value.publicKey), privateKey:wrap(value.privateKey) };
        return value;
    }
    function algorithm(value) {
        if (!value || typeof value !== 'object') return value;
        const result={...value};
        if(result.public?.__cryptoKey)result.public=key(result.public.__cryptoKey);
        return result;
    }
    return {
        hashNew(algorithm,secret){return put('hash',secret===null?createHash(algorithm):createHmac(algorithm,secret))},
        hashUpdate(id,data){get(id,'hash').update(data)},
        hashDigest(id){const hash=get(id,'hash');try{return hash.digest()}finally{resources.drop(id)}},
        hashCopy(id){const hash=get(id,'hash');if(typeof hash.copy!=='function')throw new TypeError('Hash copy unavailable');return put('hash',hash.copy())},
        timingSafeEqual:(a,b)=>timingSafeEqual(a,b),
        randomBytes(size){if(!Number.isSafeInteger(size)||size<0||size>1048576)throw new RangeError('Invalid random byte length');return randomBytes(size)},
        async generateKey(alg, extractable, usages) { return wrap(await subtle.generateKey(algorithm(alg),extractable,usages)); },
        async importKey(format, data, alg, extractable, usages) { return wrap(await subtle.importKey(format,data,algorithm(alg),extractable,usages)); },
        exportKey: (format,id) => subtle.exportKey(format,key(id)),
        encrypt: (alg,id,data) => subtle.encrypt(algorithm(alg),key(id),data),
        decrypt: (alg,id,data) => subtle.decrypt(algorithm(alg),key(id),data),
        sign: (alg,id,data) => subtle.sign(algorithm(alg),key(id),data),
        verify: (alg,id,signature,data) => subtle.verify(algorithm(alg),key(id),signature,data),
        digest: (alg,data) => subtle.digest(algorithm(alg),data),
        deriveBits: (alg,id,length) => subtle.deriveBits(algorithm(alg),key(id),length),
        async deriveKey(alg,id,derived,extractable,usages) { return wrap(await subtle.deriveKey(algorithm(alg),key(id),algorithm(derived),extractable,usages)); },
        wrapKey: (format,id,wrapping,alg) => subtle.wrapKey(format,key(id),key(wrapping),algorithm(alg)),
        async unwrapKey(format,data,unwrapping,unwrapAlg,alg,extractable,usages) { return wrap(await subtle.unwrapKey(format,data,key(unwrapping),algorithm(unwrapAlg),algorithm(alg),extractable,usages)); },
    };
}
