import {buildSync} from 'esbuild';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const bundle=source=>buildSync({stdin:{contents:source,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,write:false,minify:true,platform:'browser',format:'iife',target:'es2020'}).outputFiles[0].text;
const libs=bundle(`globalThis.__sandboxLodash__=require('lodash');globalThis.__sandboxBuffer__=require('buffer/').Buffer;globalThis.Buffer=globalThis.__sandboxBuffer__;`);
const streams=bundle(`const streams=require('web-streams-polyfill');Object.assign(globalThis,streams);`);
const read=name=>fs.readFileSync(new URL('./guest/'+name,import.meta.url),'utf8');
const source=[read('base.js'),libs,streams,read('abort-buffer.js'),read('types.js'),'__installStructuredClone__();',read('web.js'),
`globalThis.crypto={randomUUID:()=>__hostCall('extras.uuid',[]),getRandomValues(array){if(!(ArrayBuffer.isView(array))||array instanceof DataView||array instanceof Float32Array||array instanceof Float64Array)throw new TypeError('Expected integer typed array');if(array.byteLength>65536)throw new RangeError('Random value limit exceeded');const bytes=__hostCall('extras.random',[array.byteLength]);new Uint8Array(array.buffer,array.byteOffset,array.byteLength).set(bytes);return array}};`,
read('crypto.js'),read('modules.js')].join('\n');
fs.writeFileSync(new URL('./generated.mjs',import.meta.url),'export const CAPABILITIES = '+JSON.stringify(source)+';\n');
console.log(JSON.stringify({capabilitySourceBytes:Buffer.byteLength(source)}));
