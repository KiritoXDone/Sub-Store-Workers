/**
 * QuickJS module loader for Deno.
 *
 * Deno 侧不直接 import 本地复制的 wasm 文件，而是让官方变体接管 wasm 装载。
 */

import { newQuickJSWASMModuleFromVariant } from 'npm:quickjs-emscripten-core@0.32.0';
import RELEASE_SYNC from 'npm:@jitl/quickjs-wasmfile-release-sync@0.32.0';

let quickJsModulePromise = null;

export async function getQuickJsModuleForDeno() {
    if (!quickJsModulePromise) {
        quickJsModulePromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    }
    return await quickJsModulePromise;
}
