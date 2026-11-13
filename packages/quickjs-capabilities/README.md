# QuickJS 脚本能力适配实现

可独立运行的脚本能力包，也由项目的 Worker 脚本引擎引用。纯 JS 库在 QuickJS 内运行，网络、表单和加密通过受控宿主接口调用。

## 运行

本包独立于根 pnpm 工作区，以下命令应在 `packages/quickjs-capabilities` 目录执行。

需要支持 Fetch、File、Web Streams 和 Web Crypto 的 Node.js。本次测试使用 Node.js 26。

```sh
npm ci
npm run build
npm test
```

`generated.mjs` 是沙箱预置代码，已随包提供，可通过 build.mjs 重新生成。

```js
import { createSandbox } from './runner.mjs';

const sandbox = await createSandbox({
  limits: { timeoutMs: 5000, memoryLimitBytes: 32 * 1024 * 1024 },
  maxBodyBytes: 8 * 1024 * 1024,
});

const result = await sandbox.run(`
  async function operator(nodes) {
    const url = new URL('https://example.com/?q=demo');
    return lodash.map(nodes, node => ({ ...node, query: url.searchParams.get('q') }));
  }
`, [{ name: 'demo' }]);
```

`run(script, input, options)` 支持 name（默认 operator）、arguments、options、targetPlatform 和 context。可通过 hostApis 提供 substore、ProxyUtils、scriptResourceCache 等宿主对象；通过 fetchImpl 注入网络适配器或测试传输。

## 能力

- 沙箱内 lodash、Buffer，以及 base64url 兼容。
- URL、URLSearchParams、文本编解码、计时器、AbortController/AbortSignal（any、timeout）。
- Headers、Request、Response：常见属性、克隆、bodyUsed、一次性消费与 JSON/Blob/FormData 读取。
- Blob、File、FormData：内存对象、重复字段、原生 multipart 编解码。
- ReadableStream、WritableStream、TransformStream：流库提供管道、tee、背压、上传、下载和取消；另有文本编码/解码流。
- Web Crypto：摘要、生成/导入/导出密钥、签名/验签、加解密、派生、密钥包装/解包。CryptoKey 的 extractable 和 usages 由原生 Web Crypto 校验。
- 常用 Node crypto 形式：createHash、createHmac、randomBytes、timingSafeEqual。
- 白名单 require 与 ESM 动态 import：lodash、buffer、url、crypto、events、stream/web，支持对应 node: 别名。宿主可通过 commonjsModules/esmModules 增加源码白名单。
- Date、RegExp、Map、Set、Error、ArrayBuffer、类型化数组、Buffer、循环引用及同一值图中的共享引用。
- 宿主调用沙箱 async callback，并等待 Promise 或接收拒绝；支持延后调用和超时清理。

## 生命周期

每次执行有独立的 QuickJS runtime、宿主资源表和取消信号。执行结束或异常退出时清理已登记的请求、流、计时器和密钥引用。默认最多 4096 个宿主句柄，单体读取/流读取默认限制为 8 MiB，可由宿主调整。

## 边界

这是常用脚本适配实现，不是完整 Node.js 或浏览器：

- 不提供真实磁盘、进程、原生扩展、任意 npm 包、UDP 或代理内核。
- events 是常用 EventEmitter 子集，Web API 包装未经过完整 Web Platform Tests。
- structuredClone 不支持 transfer 列表；CryptoKey、Blob 等宿主句柄仅本次执行有效，不应作为持久化结果返回。
- 两个内存堆之间的任意原地修改不会自动双向同步；纯 JS 工具函数应优先在沙箱内运行。
- 不通用包装任意新返回的宿主函数；沙箱内库返回的函数可正常使用。
- ESM 命名导出限于 install.mjs 列出的名称，默认导出包含对应模块对象。
- 接入者提供的任意外部宿主任务仍需自行配合取消。

## 验证

test-results.json 和 test-results.tap 是此前的本地 Node 测试记录。CI 还会运行这 12 组测试以及实际 Worker 预览接口的针对性测试。

Workers 的 Web API 和算法支持以实际运行环境为准；这些测试不能证明所有第三方脚本都兼容。
