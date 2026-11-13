import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {runScriptOnce,normalizeSubStoreScriptForQuickJs} from './src/quickjs/substore-script-engine.js';

export async function createSandbox({hostApis={},limits={},...capabilityOptions}={}) {
    const quickjsModule=await newQuickJSWASMModuleFromVariant(variant);
    return {
        async run(script,input=[],{name='operator',arguments:args={},options={},targetPlatform,context}={}) {
            const $substore=hostApis.substore||{env:{}};
            const runtimes=[];
            const tracked={newRuntime(){const runtime=quickjsModule.newRuntime();runtimes.push(runtime);return runtime}};
            try { return await runScriptOnce({name,script:normalizeSubStoreScriptForQuickJs(name,script),$arguments:args,$options:options,$substore,
                hostRoots:{...hostApis,substore:$substore},callArgs:[input,targetPlatform,context],quickjsModule:tracked,capabilityOptions,
                limits:{timeoutMs:5000,memoryLimitBytes:32*1024*1024,maxStackSizeBytes:512*1024,...limits}}); } finally { if(runtimes.some(runtime=>runtime.alive))throw new Error('Sandbox runtime cleanup failed'); }
        },
    };
}
