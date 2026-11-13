import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const version = (await readFile('public/.frontend-version', 'utf8')).trim();
if (!version) throw new Error('Official frontend release is missing');
await access('public/frontend/index.html');
const redirect = path.resolve('.wrangler/deploy/config.json');
const { configPath } = JSON.parse(await readFile(redirect, 'utf8'));
if (typeof configPath !== 'string') throw new Error('Missing generated Wrangler configuration');
const output = path.resolve(path.dirname(redirect), configPath);
const expected = path.resolve('dist/single-workers') + path.sep;
if (!output.startsWith(expected)) throw new Error('Wrangler points outside the current Worker build');
const config = JSON.parse(await readFile(output, 'utf8'));
if (config.assets?.binding !== 'ASSETS' || config.assets?.not_found_handling !== 'single-page-application' || config.assets?.run_worker_first !== true) {
    throw new Error('Worker frontend asset binding is not configured correctly');
}
const assets = path.resolve(path.dirname(output), config.assets.directory || '');
if (!assets.startsWith(expected)) throw new Error('Worker assets point outside the current build');
await access(path.join(assets, 'index.html'));
