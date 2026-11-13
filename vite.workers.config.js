/**
 * Sub-Store Workers - Vite 配置
 *
 * 重要说明：
 * Cloudflare Vite 插件会自动处理 Worker 入口和静态资源。
 * 但 Sub-Store 源码需要特殊的代码替换处理。
 */
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'node:path';
import { SUB_STORE_PATH, subStoreTransformPlugin } from './vite.substore-transform.js';

export default defineConfig({
    publicDir: 'public/frontend',
    build: {
        outDir: 'dist/single-workers',
    },
    plugins: [
        subStoreTransformPlugin(),
        cloudflare(),
    ],
    resolve: { alias: { '@': path.join(SUB_STORE_PATH, 'src') } },
    // 开发服务器配置
    server: {
        strictPort: true,
        cors: {
            origin: '*',
            methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
            credentials: true,
        },
    },
});
