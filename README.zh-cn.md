# FreeLLMAPI Worker

**运行在 Cloudflare 上的个人 AI API 网关：聚合上游 Provider，通过统一 API 调用，并提供 Web 管理后台。**

[English](README.md) · **简体中文** · [部署指南](cloudflare/README.md) · [Catalog 与资源管理](cloudflare/RESOURCE-CATALOG.md)

本项目基于 [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) 改造，复用其 Provider、模型目录、路由、回退和额度管理，在 Cloudflare Workers 中运行。无需 VPS、Docker 或独立 Node 服务。

## 分支说明

| 分支 | 用途 |
| --- | --- |
| `main` | 保留上游桌面／Node 版本，作为同步来源 |
| `cloudflare/workers-runtime` | 独立维护 Cloudflare 版本；部署和本说明均以此分支为准 |

Cloudflare 部署应始终选择 `cloudflare/workers-runtime`。不以合并到 `main` 为发布步骤，也不要将桌面安装说明用于 Worker。吸收上游更新时，应审查并验证与 Workers 的兼容性。

## 当前功能

- **统一推理入口**：OpenAI-compatible Chat Completions、SSE 流式输出与 Responses；支持指定模型或通过 `auto` 路由。
- **路由与回退**：复用模型选择、上游限流、冷却、健康检查和额度状态管理。
- **凭证与应用 Key**：上游凭证加密保存；下游应用使用独立 API Key，可配置模型权限、禁用、轮换和删除。
- **Workers AI**：本账户通过原生 `AI.run()` 绑定调用；其他账户可通过 `account_id:api_token` 接入 REST Provider。
- **Web 后台**：管理凭证、模型、路由、应用 Key、Catalog 和资源；管理员身份由 Cloudflare Access 验证。
- **Catalog**：浏览、筛选、排序、编辑模型记录，检查签名更新及查看历史；区分官方、用户和 AI 管理的数据。
- **管理 MCP**：查询和编辑 Catalog，注册动态 OpenAI-compatible chat Provider；动态 Provider 注册与添加模型、添加凭证是分别完成的步骤。
- **资源管理**：成功请求分析写入 Analytics Engine，路由所需精简记录保留在 SQLite；提供 SQL 读写诊断、存储用量和清理目标设置。
- **持久化维护**：DO Alarm 每 5 分钟执行维护；Catalog 每 12 小时检查，Custom Model 同步每 6 小时检查。

Embedding、图像、音频等能力取决于已有适配器、模型和凭证。动态 MCP Provider 适配器目前只支持 OpenAI-compatible chat。SiliconFlow Global（`siliconflow`）与 China（`siliconflow-cn`）使用独立端点、凭证和模型身份。

## 运行架构

请求经 Workers 进入一个名为 `primary` 的 SQLite Durable Object，复用 Express 路由与 Provider。React 后台由 Workers Static Assets 提供。

| 组件 | 用途 |
| --- | --- |
| Workers | 请求入口、Access 校验、限流、静态资源 |
| `GATEWAY` / `Gateway` | 单个 SQLite DO：凭证、应用配置、Catalog、额度、路由和会话 |
| `AI` | 本账户 Workers AI 推理 |
| `ASSETS` | Web 管理后台 |
| `REQUEST_ANALYTICS` | Analytics Engine 成功请求／尝试事件 |
| `API_RATE_LIMITER` | 请求准入限流 |

无需创建 D1 数据库。面向个人或小规模网关，未实现多租户和跨 DO 分片。

## 部署

### 1. 获取正确分支

使用 Node.js 22 或 24，建议 24。

```bash
git clone --branch cloudflare/workers-runtime --single-branch https://github.com/happy2first/free-llm-api-worker.git
cd free-llm-api-worker
npm ci
npx wrangler login
```

### 2. 配置运行时

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | Worker Secret | 64 位十六进制加密密钥 |
| `TEAM_DOMAIN` | 运行时变量 | Access 团队域名，如 `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | 运行时变量 | 后台 Access 应用的 Audience |

首次部署可生成并保存加密密钥，再通过提示输入 Secret：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put ENCRYPTION_KEY
```

升级现有实例时保留原密钥。更换密钥需要迁移旧密文；丢失密钥后无法解密已有凭证。无需 `SETUP_CODE` 或本地管理员账号。

当前 `wrangler.jsonc` 声明了 Analytics Engine 绑定；部署前须在目标账户启用该服务。若不使用，将 `analytics_engine_datasets` 设为 `[]`。无绑定时仍可推理，但最近事件仅在内存中保留，不构成持久分析历史。

### 3. 配置 Access

为实际使用的域名创建两条自托管 Access 应用：

| 应用 | 路径 | 策略 |
| --- | --- | --- |
| Admin | 整个域名 | Allow，仅允许管理员身份 |
| API | 同域名的 `v1/*` | Bypass / Everyone |

将 Admin 应用的 AUD 写入 `ACCESS_AUD`。API Bypass 仅绕过 Access，应用 API Key 校验仍生效；不要绕过整个域名或管理 API。所有获得后台 Access 授权的身份都有管理权限。

### 4. 部署并初始化使用

```bash
npm run deploy:cloudflare
```

Cloudflare Git 构建使用生产分支 `cloudflare/workers-runtime`、根目录 `/`、构建命令 `npm run build:cloudflare`、部署命令 `npx wrangler deploy --config wrangler.jsonc`。详细步骤见 [部署指南](cloudflare/README.md)。

通过 Access 登录后台，添加上游凭证、确认模型与路由配置，再创建下游应用 Key。Workers AI 原生凭证首次自动创建，可禁用或删除，后续启动不会重新创建。

升级时保持 Worker 名称、`Gateway` 类名、`primary` 对象名、迁移历史及加密密钥稳定，无需删除 Worker 或数据库。

## API 使用

OpenAI-compatible 客户端设置：

- Base URL：`https://YOUR-DOMAIN/v1`
- API Key：后台创建的**下游应用 Key**，不是 Provider 凭证
- Model：`GET /v1/models` 返回的 ID，或配置好回退链后的 `auto`

```bash
curl https://YOUR-DOMAIN/v1/models \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY'

curl https://YOUR-DOMAIN/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

SSE 调用将 `stream` 改为 `true`，并为 curl 加上 `-N`。

首次验收：无痕后台进入 Access；无 Key 请求 `/v1/models` 返回 JSON 401，有效 Key 返回 200；应用 Key 不能访问管理 API。然后指定一个模型完成真实普通和流式调用，再测试 `auto`。

## MCP 与 Catalog

| 入口 | 用途 | 身份要求 |
| --- | --- | --- |
| `/api/catalog/mcp` | Catalog 与 Provider 管理工具 | 管理员 Access 身份 |
| `/mcp` | 网关查询与路由工具 | 启用 Agent compatibility，且同时满足 Access 与网关 Bearer Key 校验 |

使用 Streamable HTTP 客户端。设置页显示基于当前域名生成的连接地址。浏览器连接测试只验证当前管理员会话，不代表外部客户端已经接通；项目没有实现 ChatGPT OAuth 接入流程。

新增动态上游的顺序为：注册 Provider → 按相同 platform ID 添加准确模型记录 → 在凭证页添加对应 Key → 实测调用。新增 Catalog 记录不会自动实现适配器或导入模型列表。“已接入”是配置状态，不是实时推理或免费额度证明。

详见 [Catalog、数据所有权、MCP 与资源管理](cloudflare/RESOURCE-CATALOG.md)。

## 验证与检查状态

```bash
npm run test:cloudflare
npm run typecheck:cloudflare
npx wrangler deploy --dry-run

# 上游 Node / CLI / 前端回归
npm run test:migrations
npm test
npm run lint
npm run build
```

Cloudflare 测试在真实 workerd 和 DO SQLite 中运行，但注入模拟 AI、Groq 和 Access 服务，不使用真实推理凭证。dry-run 验证构建与打包，不执行部署。完整 Node 测试失败时，后续 CLI／前端测试可能尚未执行。

截至文档核对基线 `a5556d30`（2026-09-18），[Cloudflare 专项 CI](https://github.com/happy2first/free-llm-api-worker/actions/runs/35311387121) 通过，[完整 Node 20/22 CI](https://github.com/happy2first/free-llm-api-worker/actions/runs/35311387149) 失败，涉及 SiliconFlow 修复测试导入路径及媒体测试与新增预置数据的冲突。该基线有 [Cloudflare 部署成功记录](https://github.com/happy2first/free-llm-api-worker/pull/1#issuecomment-5660259060)，但部署记录不等于真实 Provider 全面验收或生产压测。后续状态以相应提交的检查与线上实测为准。

GitHub 提交旁的红叉表示关联检查失败，不表示提交没有保存，也不必然表示部署失败；应查看具体工作流和日志。

## 使用边界

- 可用模型、额度、费用和功能取决于各 Provider 账户；项目名称不代表所有请求永久免费。
- 存储清理目标默认 768 MiB，优先清理旧日志和旧会话，保护核心状态及最近活跃会话；它不是硬存储上限。
- 资源面板展示 Gateway SQLite 与内存诊断，不是账户级剩余额度或账单。旧 Analytics 页面不包含完整新增成功请求历史。
- Workers 不提供桌面升级、本机文件备份、局域网 Provider、SOCKS／HTTP CONNECT 代理或 sharp 图像压缩；支持外部 HTTPS 与受信 Fetch Relay。
- 数据恢复使用 Cloudflare DO SQLite 恢复能力；首次部署不自动导入桌面数据库。
- 其他协议路由保留，但默认仅 `/v1/*` 公开应用 Key 访问；`/v1beta/*`、`/api/*` 和 MCP 仍要求 Access。
- 在实际账户中逐一验证准备启用的 Provider，并按预计流量验证单 DO 容量。

## 文档与致谢

- [部署与认证](cloudflare/README.md)
- [架构与上游同步](cloudflare/ARCHITECTURE.md)
- [Catalog、MCP、SQL 与存储策略](cloudflare/RESOURCE-CATALOG.md)
- [上游 FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)

沿用 [MIT License](LICENSE)，保留上游作者 Tashfeen Ahmed 的版权声明。
