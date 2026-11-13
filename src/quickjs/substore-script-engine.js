// Keep the Worker and the standalone capability package on one script engine.
import { ensureSubStoreQuickJsScriptEngineInstalled as install } from '../../packages/quickjs-capabilities/src/quickjs/substore-script-engine.js';
import { setDebugMode } from '../../packages/quickjs-capabilities/src/logger.js';

export function ensureSubStoreQuickJsScriptEngineInstalled(options = {}) {
    if ('debug' in options) setDebugMode(options.debug);
    return install(options);
}
