import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{createServer}from'node:http';
import{createSandbox}from'./runner.mjs';
let server,base;const network={aborted:0};
before(async()=>{
 server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/json'});res.end();return}
  if(req.url==='/slow'){res.writeHead(200,{'content-type':'text/plain'});res.write('part');const timer=setTimeout(()=>res.end('end'),400);res.on('close',()=>{clearTimeout(timer);if(!res.writableFinished)network.aborted++});return}
  if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/plain'});res.write(Buffer.from([0xe4]));setTimeout(()=>res.end(Buffer.from([0xb8,0xad,65])),15);return}
  const chunks=[];req.on('data',part=>chunks.push(part));req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,method:req.method,contentType:req.headers['content-type'],body:Buffer.concat(chunks).toString()}))});
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
const script=body=>'async function operator(){'+body+'}';
async function check(body,expected,options={}){const box=await createSandbox(options);assert.deepEqual(await box.run(script(body)),expected)}

test('sandbox lodash and Buffer retain mutation, async callbacks and base64url',async()=>{
 await check(`const o={};lodash.set(o,'a.b',3);const a=await Promise.all(lodash.map([1,2],async x=>x+1));const b=Buffer.alloc(4);b.writeUInt32BE(0x12345678);return [o.a.b,lodash.chain([3,1,2]).sortBy().take(2).value(),a,b.readUInt32BE(),Buffer.from([255]).toString('base64url'),Buffer.from('_w','base64url')[0]];`,[3,[1,2],[2,3],0x12345678,'_w',255]);
});
test('Headers and Response support cloning, bodyUsed, JSON and invalid states',async()=>{
 await check(`const h=new Headers({'X-Test':'a'});h.append('x-test','b');const r=Response.json({x:1},{status:201,headers:h});const copy=r.clone();const data=await r.json();let used=false,invalid=false;try{await r.text()}catch{used=true}try{new Response('x',{status:204})}catch{invalid=true}return [h.get('X-Test'),r.status,data.x,r.bodyUsed,await copy.json(),used,invalid,Response.error().status,Response.redirect('https://example.com').headers.get('location')];`,['a, b',201,1,true,{x:1},true,true,0,'https://example.com/']);
});
test('Blob/File and repeated FormData fields round-trip through multipart',async()=>{
 await check(`const blob=new Blob(['中文',new Uint8Array([65])],{type:'text/plain'});const f=new File([blob],'a.txt',{type:'text/plain',lastModified:42});const form=new FormData();form.append('tag','a');form.append('tag','b');form.append('file',f);const r=new Request('https://example.com/upload',{method:'POST',body:form});const decoded=await r.clone().formData();return [blob.size,await blob.slice(0,6).text(),f.name,f.lastModified,form.getAll('tag'),decoded.get('file') instanceof File,await decoded.get('file').text(),r.headers.get('content-type').startsWith('multipart/form-data; boundary='),(await r.text()).includes('filename="a.txt"')];`,[7,'中文','a.txt',42,['a','b'],true,'中文A',true,true]);
});
test('local fetch handles Request, multipart upload, redirects and immutable headers',async()=>{
 await check(`const f=new FormData();f.append('file',new Blob(['file body']),'x.txt');const r=await fetch(new Request('${base}/json',{method:'POST',body:f}));const data=await r.json();const redirected=await fetch('${base}/redirect');let immutable=false;try{redirected.headers.set('x','v')}catch{immutable=true}return [data.method,data.body.includes('file body'),data.contentType.startsWith('multipart/form-data'),redirected.redirected,redirected.url.endsWith('/json'),immutable];`,['POST',true,true,true,true,true]);
});
test('streams support decode, upload, tee, pipeTo and body locking',async()=>{
 await check(`const r=await fetch('${base}/stream');const chunks=[];await r.body.pipeThrough(new TextDecoderStream()).pipeTo(new WritableStream({write(c){chunks.push(c)}}));const source=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('one'));c.enqueue(new TextEncoder().encode('two'));c.close()}});const upload=await(await fetch('${base}/json',{method:'POST',body:source,duplex:'half'})).json();const[a,b]=new Blob(['tee']).stream().tee();const texts=await Promise.all([new Response(a).text(),new Response(b).text()]);const locked=new Response('locked');const reader=locked.body.getReader();let rejected=false;try{locked.clone()}catch{rejected=true}reader.releaseLock();return[chunks.join(''),upload.body,texts,rejected,await locked.text(),r.bodyUsed];`,['中A','onetwo',['tee','tee'],true,'locked',true]);
});
test('abort remains effective after response headers; stream cancel closes transport',async()=>{
 const previous=network.aborted;await check(`const c=new AbortController();const r=await fetch('${base}/slow',{signal:c.signal});setTimeout(()=>c.abort(),25);let aborted;try{await r.text()}catch(e){aborted=e.name}const second=await fetch('${base}/slow');await second.body.cancel();return aborted;`,'AbortError');await new Promise(r=>setTimeout(r,25));assert.ok(network.aborted>previous);
});
test('Web Crypto HMAC and AES-GCM enforce extractability',async()=>{
 await check(`const data=new TextEncoder().encode('message');const h=await crypto.subtle.importKey('raw',new Uint8Array([1,2,3]),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);const signed=await crypto.subtle.sign('HMAC',h,data);let hidden=false;try{await crypto.subtle.exportKey('raw',h)}catch{hidden=true}const key=await crypto.subtle.generateKey({name:'AES-GCM',length:128},true,['encrypt','decrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,encrypted);return[h instanceof CryptoKey,h.type,h.algorithm.hash.name,await crypto.subtle.verify('HMAC',h,signed,data),hidden,new TextDecoder().decode(plain),(await crypto.subtle.exportKey('raw',key)).byteLength];`,[true,'secret','SHA-256',true,true,'message',16]);
});
test('key pairs, derivation and wrapping use native CryptoKey handles',async()=>{
 await check(`const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const msg=new Uint8Array([1,2]);const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,msg);const source=await crypto.subtle.importKey('raw',new Uint8Array([1,2,3]),'HKDF',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array([1]),info:new Uint8Array()},source,128);const key=await crypto.subtle.generateKey({name:'AES-GCM',length:128},true,['encrypt','decrypt']);const wrapping=await crypto.subtle.generateKey({name:'AES-KW',length:128},true,['wrapKey','unwrapKey']);const wrapped=await crypto.subtle.wrapKey('raw',key,wrapping,'AES-KW');const restored=await crypto.subtle.unwrapKey('raw',wrapped,wrapping,'AES-KW','AES-GCM',true,['encrypt','decrypt']);return[await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,sig,msg),bits.byteLength,Buffer.from(await crypto.subtle.exportKey('raw',key)).equals(Buffer.from(await crypto.subtle.exportKey('raw',restored)))];`,[true,16,true]);
});
test('rich values preserve cycles, types and shared ArrayBuffers through host conversion',async()=>{
 const make=()=>{const buffer=new ArrayBuffer(8),a=new Uint16Array(buffer,0,2),b=new Uint8Array(buffer,2,2);a[1]=258;const map=new Map();const x={date:new Date(0),rx:/abc/gi,map,set:new Set(['x']),a,b};map.set(x,x);return x};
 await check(`const x=ProxyUtils.make();const copy=structuredClone(x);return[x.date instanceof Date,x.rx.flags,x.map.get(x)===x,x.set.has('x'),x.a instanceof Uint16Array,x.a.buffer===x.b.buffer,ProxyUtils.inspect(copy),copy.map.get(copy)===copy];`,[true,'gi',true,true,true,true,true,true],{hostApis:{ProxyUtils:{make,inspect(x){return x.date instanceof Date&&x.rx instanceof RegExp&&x.map instanceof Map&&x.map.get(x)===x&&x.set instanceof Set&&x.a instanceof Uint16Array&&x.a.buffer===x.b.buffer}}}});
});
test('async host callbacks resolve later and propagate rejections',async()=>{
 await check(`const a=await ProxyUtils.mapAsync([1,2],async n=>{await new Promise(r=>setTimeout(r,2));return n+1});const b=await ProxyUtils.later(async n=>n*2);let rejected=false;try{await ProxyUtils.later(async()=>{throw new Error('callback rejected')})}catch(e){rejected=String(e).includes('callback rejected')}return[a,b,rejected];`,[[2,3],6,true],{hostApis:{ProxyUtils:{mapAsync:(xs,fn)=>Promise.all(xs.map(fn)),later:async fn=>{await new Promise(r=>setTimeout(r,10));return await fn(3)}}}});
});
test('CommonJS/ESM whitelist supports caching, crypto and events while denying fs',async()=>{
 await check(`const{Buffer:B}=await import('node:buffer');const math=await import('custom:math');const E=require('events'),e=new E();let n=0;e.once('add',x=>n+=x);e.emit('add',3);e.emit('add',3);const hash=require('crypto').createHash('sha256').update('abc').digest('hex');const counter=require('counter');let cjs=false,esm=false;try{require('node:fs')}catch{cjs=true}try{await import('node:fs')}catch{esm=true}return[B===Buffer,math.twice(3),n,hash,counter(),require('counter')(),cjs,esm];`,[true,6,3,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',1,2,true,true],{commonjsModules:{counter:'let n=0;module.exports=()=>++n'},esmModules:{'custom:math':'export const twice=x=>x*2;'}});
});
test('body/resource quotas and never-settled callbacks clean up on failure',async()=>{
 const limited=await createSandbox({maxBodyBytes:4,maxHandles:12});await assert.rejects(limited.run(script(`return await new Response('too large').text()`)),/limit/);await assert.rejects(limited.run(script(`return Array.from({length:20},()=>new Blob(['x'])).length`)),/limit/);
 const timeout=await createSandbox({limits:{timeoutMs:250},hostApis:{ProxyUtils:{wait:fn=>fn()}}});await assert.rejects(timeout.run(script(`return await ProxyUtils.wait(async()=>await new Promise(()=>{}))`)),/timeout/);
});
