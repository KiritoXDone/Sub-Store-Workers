import { parse } from 'acorn';

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

function referencesSurge(node) {
    let found = false;
    walk(node, (child) => { if (child.type === 'Identifier' && child.name === 'isSurge') found = true; });
    return found;
}

const WORKER_COMPATIBLE_CONDITIONS = new Set([
    'isLoon,isSurge,isEgern',
    'isSurge,isLoon,isEgern',
    'isSurge,isEgern',
    'isQX,isLoon,isSurge,isGUIforCores,isEgern',
    'isLoon,isSurge,isNode,isEgern',
    'isSurge,isEgern,isStash,isShadowRocket',
]);

function disjunctionNames(node) {
    if (node.type === 'Identifier') return [node.name];
    if (node.type !== 'LogicalExpression' || node.operator !== '||') return null;
    const left = disjunctionNames(node.left);
    const right = disjunctionNames(node.right);
    return left && right ? [...left, ...right] : null;
}

// Extend upstream's shared platform branches, leaving Surge-only options disabled.
export function enableWorkerBranches(source, workerExpression, minimum = 0) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const positions = [];
    walk(ast, (node) => {
        if (node.type !== 'IfStatement' || !referencesSurge(node.test)) return;
        if (node.test.type === 'Identifier' && node.test.name === 'isSurge') return;
        const names = disjunctionNames(node.test);
        if (!names || !WORKER_COMPATIBLE_CONDITIONS.has(names.join(','))) {
            throw new Error('[sub-store-env] unsupported Surge branch requires review');
        }
        positions.push(node.test.end);
    });
    if (positions.length < minimum) throw new Error('[sub-store-env] platform branches changed');
    for (const position of positions.sort((a, b) => b - a)) {
        source = source.slice(0, position) + ' || ' + workerExpression + source.slice(position);
    }
    return source;
}

export function markWorkerBackend(source) {
    const original = "let backend = 'Node';";
    if (!source.includes(original)) throw new Error('[sub-store-env] backend identity changed');
    return source.replace(original, "let backend = 'Workers';");
}

// Expose the runtime identity in upstream's ENV() without enabling Surge.
export function markWorkerEnvironment(source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const declaration = ast.body.find((node) => node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'ENV')?.declaration;
    if (!declaration) return source;
    const returns = declaration.body.body.filter((node) => node.type === 'ReturnStatement');
    const object = returns.length === 1 && returns[0].argument;
    if (!object || object.type !== 'ObjectExpression') throw new Error('[sub-store-env] ENV return contract changed');
    const marker = object.properties.find((property) => !property.computed && property.key?.name === 'isWorker');
    if (marker) {
        if (marker.value.type === 'Literal' && marker.value.value === true) return source;
        throw new Error('[sub-store-env] upstream isWorker requires review');
    }
    return source.slice(0, object.start + 1) + ' isWorker: true,' + source.slice(object.start + 1);
}
