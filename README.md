# Sub-Store Workers

在 Cloudflare Workers 上运行 Sub-Store。使用 QuickJS-WASM 执行订阅脚本，保留官方订阅转换、集合、文件、分享、Gist 备份和定时任务。

本项目没有 Dashboard、账号、注册、登录、JWT 或用户管理。根路径提供官方 Release 的 Sub-Store 前端，私有路径提供后端 API。

> 本次为破坏性更新：Cloudflare 的迁移会删除旧 IndexDO 和 UserDO 命名空间，创建全新的单库 StoreDO。旧账号、用户数据和分享不会迁移。需要的数据应自行从外部备份恢复。

## 使用

后端管理地址由 `SUB_STORE_FRONTEND_BACKEND_PATH` 设置，例如：

```text
https://你的Worker域名/your-private-path
```

打开同域根路径的官方前端，填写这个完整地址。私有路径用于保护管理 API，不要把它当成公开分享地址。

公开分享链接使用 `/share/sub/:name`、`/share/col/:name` 或 `/share/file/:name`，并携带 `token`。令牌直接在唯一数据集中按资源类型、名称、有效期和次数验证，不需要用户前缀。恢复外部备份后，已有令牌仍按原值匹配。

## Cloudflare 部署

Fork 仓库，在 GitHub Actions 配置：

| 配置 | 类型 | 说明 |
| --- | --- | --- |
| `CF_API_TOKEN` | Secret | Cloudflare Workers 部署令牌 |
| `CF_ACCOUNT_ID` | Secret | Cloudflare 账号 ID |
| `CF_WORKER_NAME` | Secret | 部署目标 Worker 名称 |
| `SUB_STORE_FRONTEND_BACKEND_PATH` | Secret | 私有后端路径，必须以 `/` 开头且不能为根路径 |
| `SUB_STORE_PUSH_SERVICE` | Secret，可选 | 通知服务 URL |
| `MMDB_COUNTRY_URL` | Variable，可选 | Country MMDB 下载地址 |
| `MMDB_ASN_URL` | Variable，可选 | ASN MMDB 下载地址 |

运行 **Deploy to Cloudflare**。同一个 Worker 提供官方前端静态资源与后端 API，不需要独立 Pages 项目，也不包含 Dashboard。

后端与官方前端均只跟随正式 Release：后端从发布对应的 tag 下载源码构建；前端使用该正式 Release 的 `dist.zip`，不追踪开发分支或预发布版本。

## 功能与边界

- QuickJS 支持 async/await、Buffer、lodash、URL、Fetch、Web Streams、Web Crypto 和异步宿主回调；每次执行有独立的时限、内存、栈和资源数量限制。
- 脚本中的 `$substore.env.isWorker` 为 `true`；`isSurge` 也为 `true`，用于沿用上游 Surge 兼容接口，`isNode` 为 `false`。
- `require` 和动态 `import` 仅支持 lodash、buffer、url、crypto、events、stream/web 白名单，不支持本地文件、任意 npm 包或本地代理内核。
- DNS 可使用上游 DoH；不提供任意 UDP DNS。
- GeoIP 从配置的 MMDB URL 按需加载，数据库和订阅数据由单库持久化；加载失败会重试，不替换有效的旧 reader。
- `SUB_STORE_PUSH_SERVICE` 支持 Shoutrrr URL，也支持 HTTP URL 中的 `[推送标题]`、`[推送内容]` 占位符。通知使用 fetch，不支持 GET/HEAD 请求体。
- HTTP 适配器遵循 Surge 接口的秒数单位，默认 30 秒，项目上限 55 秒，覆盖响应体读取；并非 Workers 的统一平台时长限制。
- 使用一个 StoreDO 持久化数据，串行处理读改写。
- 每六小时触发上游产物同步；没有启用的同步项时不操作。不执行每个产物单独配置的 Cron 表达式，这些产物也按全局六小时频率同步。

## 本地开发

需要 Node.js 24 及 `package.json` 指定版本的 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm run fetch:substore
pnpm run fetch:frontend
cp wrangler.toml.example wrangler.toml
# 在 wrangler.toml 中配置私有后端路径
pnpm run dev:workers
```

依赖使用 `pnpm-lock.yaml`。后端依赖使用对应正式 Release 自带的锁文件。`SUBSTORE_VERSION` 可指定正式发布版本；未指定时获取最新正式 Release。

## License

[AGPL-3.0](LICENSE)
