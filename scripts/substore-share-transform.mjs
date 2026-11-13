import { parse } from 'acorn';

function replaceRequired(source, before, after) {
    if (!source.includes(before)) throw new Error(`[sub-store-share] upstream contract changed: ${before}`);
    return source.replace(before, after);
}

export function transformShareSupport(source, id) {
    if (id.endsWith('/restful/token.js')) {
        const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const sign = ast.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'signToken');
        const guard = sign?.body.body[0];
        if (guard?.type !== 'IfStatement' || source.slice(guard.test.start, guard.test.end) !== '!ENV().isNode') {
            throw new Error('[sub-store-share] signToken environment guard changed');
        }
        source = source.slice(0, guard.start) + source.slice(guard.end);
        source = replaceRequired(source, 'let token = payload?.token;', `let token = payload?.token;
    const userId = globalThis.__substore_get_active_context__?.()?.user?.id;
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Share user context unavailable');
    const prefix = 'u' + userId + '.';
    if (typeof token === 'string' && token && !token.startsWith(prefix)) token = prefix + token;`);
        source = replaceRequired(source, 'token = nanoid.customAlphabet(nanoid.urlAlphabet)();', "token = prefix + crypto.randomUUID().replace(/-/g, '');");
        return source;
    }
    if (id.endsWith('/restful/miscs.js')) {
        source = replaceRequired(source, "import env from '@/utils/env';", "import baseEnv from '@/utils/env';");
        return replaceRequired(source, 'function getEnv(req, res) {', `function getEnv(req, res) {
    const user = globalThis.__substore_get_active_context__?.()?.user;
    const env = { ...baseEnv, feature: { ...baseEnv.feature, share: true },
        meta: { ...baseEnv.meta, node: { env: { SUB_STORE_FRONTEND_BACKEND_PATH: '/' + (user?.path || '') } } } };`);
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
