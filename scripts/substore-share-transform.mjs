import { parse } from 'acorn';

function replaceRequired(source, before, after) {
    if (!source.includes(before)) throw new Error(`[sub-store-share] upstream contract changed: ${before}`);
    return source.replace(before, () => after);
}

export function transformShareSupport(source, id) {
    if (id.endsWith('/restful/token.js')) {
        const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const sign = ast.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'signToken');
        const guard = sign?.body.body[0];
        const condition = guard?.test && source.slice(guard.test.start, guard.test.end).replace(/\s+/g, '');
        if (guard?.type !== 'IfStatement' || guard.alternate ||
            guard.consequent?.body?.length !== 1 || guard.consequent.body[0].type !== 'ReturnStatement' ||
            !['!ENV().isNode', '!ENV().isNode&&!ENV().isSubsCheckPro'].includes(condition)) {
            throw new Error('[sub-store-share] signToken environment guard changed');
        }
        source = source.slice(0, guard.start) + source.slice(guard.end);
        if (!source.includes('let token = payload?.token;')) throw new Error('[sub-store-share] token payload changed');
        const updated = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const generator = updated.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'generateShareToken');
        if (generator) {
            if (!source.includes('token = generateShareToken();')) throw new Error('[sub-store-share] token generator call changed');
            source = source.slice(0, generator.start) + "function generateShareToken() { return crypto.randomUUID().replace(/-/g, ''); }" + source.slice(generator.end);
        } else {
            source = replaceRequired(source, 'token = nanoid.customAlphabet(nanoid.urlAlphabet)();', "token = crypto.randomUUID().replace(/-/g, '');");
        }
        return source;
    }
    if (id.endsWith('/restful/miscs.js')) {
        source = replaceRequired(source, "import env from '@/utils/env';", "import baseEnv from '@/utils/env';");
        return replaceRequired(source, 'function getEnv(req, res) {', `function getEnv(req, res) {
    const secretPath = String(globalThis.__substore_get_active_context__?.()?.env?.SUB_STORE_FRONTEND_BACKEND_PATH || '/').trim().replace(new RegExp('/+$'), '') || '/';
    const env = { ...baseEnv, feature: { ...baseEnv.feature, share: true },
        meta: { ...baseEnv.meta, node: { ...baseEnv.meta?.node, env: { ...baseEnv.meta?.node?.env, SUB_STORE_FRONTEND_BACKEND_PATH: secretPath } } } };`);
    }
    if (id.endsWith('/restful/index.js')) {
        source = replaceRequired(source, '    // register routes', `    // Token validation applies to both public and private-path share requests.
    const shareApp = Object.create($app);
    shareApp.get = (path, callback) => $app.get(path, path.startsWith('/share/')
        ? async (req, res, next) => {
            const token = typeof req.query.token === 'string' && consumeShareToken({
                token: req.query.token, type: path.split('/')[2], name: req.params.name,
            });
            if (!token) { res.status(404).end(); return; }
            req.subStoreShareToken = token;
            return await callback(req, res, next);
        } : callback);
    // register routes`);
        source = replaceRequired(source, 'registerDownloadRoutes($app);', 'registerDownloadRoutes(shareApp);');
        return replaceRequired(source, 'registerFileRoutes($app);', 'registerFileRoutes(shareApp);');
    }
    return source;
}
