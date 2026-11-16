import { parse } from 'acorn';

// The runtime is a Worker, while upstream still needs the Surge-compatible API.
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
