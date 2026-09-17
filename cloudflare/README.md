# FreeLLMAPI on Cloudflare

本仓库在 FreeLLMAPI 上增加 Cloudflare 运行目标，保留上游 Node/桌面源码以便继续同步。部署到 Cloudflare 的内容不包含桌面应用，也不依赖 VPS、容器或外部 Node 服务。

运行路径：**Workers → 一个 SQLite Durable Object → 原有 Express 路由、Provider、Catalog、Fallback 和额度引擎**。原有 React 管理后台通过 Workers Static Assets 提供。

## 功能

- 上游凭证：沿用“平台密钥”页面，支持 Google、Groq、NVIDIA、Cloudflare 和上游已有 Provider；状态、模型范围、启用/禁用与路由规则沿用原实现。
- 下游接口：沿用“API 密钥”页面中的客户端配置，创建、禁用、轮换、删除各应用独立 Key。应用 Key 不能访问管理 API。
- OpenAI Chat Completions、流式 SSE、Responses，以及原有 Anthropic、Gemini、Ollama 协议路由保留。各模型实际支持的模态、工具与参数仍取决于 Provider。
- Cloudflare Workers AI：首次初始化生成名为 `Workers AI (native binding)` 的凭证记录，调用 `AI.run()`，无需另存本账户的 API Token。可在后台禁用或删除；之后启动不会重新创建。其他账户仍可按上游格式 `account_id:api_token` 添加，走原 REST Provider。
- 数据：凭证密文、会话、应用 Key、模型、Catalog、额度使用、冷却、路由配置、异常请求、路由必需的精简统计和缓存保存在 Durable Object SQLite。普通控制台日志只留内存和 Workers Logs；成功请求分析写 Analytics Engine。
- 维护：Durable Object Alarm 每 5 分钟唤醒，执行健康检查、冷却恢复和清理；Catalog 每 12 小时检查，Custom Model 同步每 6 小时检查。调度不依赖用户访问，也不依赖 `setInterval`。保留 Catalog 签名检查和原有免费/付费目录规则。

## 部署

使用 Node.js 22 或 24（建议 24）。Wrangler 版本已锁定。

```bash
npm ci
npx wrangler login
```

生成一个加密密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

设置为 Worker Secrets；每条命令会提示输入，若 Worker 尚不存在，按 Wrangler 提示创建：

```bash
npx wrangler secret put ENCRYPTION_KEY
npm run deploy:cloudflare
```

- `ENCRYPTION_KEY` 必须为 64 位十六进制值；保存好，丢失后无法解密已有 Provider 凭证。不要用普通环境变量或提交到仓库。更换它不是普通配置修改，需要迁移旧密文。
- 已移除 Cloudflare 部署的 `SETUP_CODE`。后台完全使用 Access 身份，无需创建本地管理员或再次登录；所有获后台 Access 应用允许的用户均有管理权限。
- 普通运行时变量 `TEAM_DOMAIN` 填团队域名（如 `https://your-team.cloudflareaccess.com`；也兼容不带协议的值），`ACCESS_AUD` 填后台 Access 应用的 Application Audience (AUD)。这两项是公开标识，不是新密码。
- 缺少加密密钥时服务不能初始化；缺少 Access 配置时后台返回 503，缺少有效 Access 身份时返回 403。`/v1/*` 始终使用原有应用 API Key 校验。
- `wrangler.jsonc` 中已经声明 `GATEWAY` SQLite Durable Object、`AI` 和 `ASSETS` 绑定及首次迁移；不需要 D1 数据库 ID。Wrangler 自动构建后部署。
- 保持 Worker 名称、`Gateway` 类名、`primary` 对象名和迁移历史稳定。更改它们可能指向新数据库。
- `keep_vars` 保留控制台设置的普通变量；绑定仍由 `wrangler.jsonc` 管理。若自行添加绑定，应同时写入配置，不能假设部署会保留未声明的绑定。

打开部署产生的 HTTPS 地址，通过 Access 登录后直接进入后台，然后在平台密钥页加入需要的上游凭证，在 API 密钥页创建应用 Key。

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

可用模型由 `GET /v1/models` 查询。`auto` 使用后台选定的路由和回退配置。

## Cloudflare 控制台操作（不删除 Worker）

1. 现有 Worker → 设置 → 构建：生产分支选 `cloudflare/workers-runtime`（本改造合并到 main 后才改回 main）；根目录 `/`；构建命令 `npm run build:cloudflare`；部署命令 `npx wrangler deploy --config wrangler.jsonc`；关闭非生产分支构建，版本命令可保持默认。保存后重新构建所选分支，避免重试旧 main 提交。
2. 先为实际使用的域名配置下面两条 **Self-hosted / 自托管** Access 应用。不要使用 Worker 的“所有流量”保护，因为它也会挡住 OpenAI API。若已启用 Worker 级保护，需要改用域名应用；账户级全局保护也不能继续挡住此 Worker 的 API。
3. Zero Trust → Access → Applications → Add an application → Self-hosted。创建 `FreeLLMAPI Admin`，Public hostname 填 Worker 的完整域名（不含 https://），Path 留空。添加 Allow 策略，Include → Emails → 只填管理员自己的邮箱。保存。复制该应用的 Application Audience (AUD)。
4. 再创建 `FreeLLMAPI API` 自托管应用，同一个域名，Path 填 `v1/*`。策略 Action 选 **Bypass**，Include 选 **Everyone**。这只绕过 Access，Worker 中的应用 Key 校验仍然生效；不要给整个域名或 `/api/*` 配 Bypass。需要访问精确 `/v1` 时，也将该路径作为本 API 应用的独立 hostname/path 条目添加。
5. Worker → 设置 → **运行时**变量和机密：Secret `ENCRYPTION_KEY`；Text `TEAM_DOMAIN`；Text `ACCESS_AUD`（复制第 3 步后台应用的 AUD，不是 API 应用 AUD）。Build 页面内的构建变量不能代替运行时变量。已配置的 `SETUP_CODE` 可删除。
6. 部署最新分支，访问域名，经 Access 登录后直接进入后台，无需本地管理员账号或 Setup Code。随后在后台添加 Provider，并为外部应用创建 API Key。
7. 验收：无痕访问后台应进入 Access；无登录、无 Key 请求 `/v1/models` 应返回 JSON 401，而不是 Access 登录页；带应用 Key 应返回 200。应用 Key 单独访问 `/api/keys` 应被 Access 拦截。

同一域名下更具体的 `v1/*` 应用优先于整个域名的后台应用。使用自定义域名时，在该域名建立这两条应用；其他 workers.dev/预览地址即使未配 Access，也会被 Worker 的 JWT 校验拒绝访问后台。需要从另一域名登录后台时，将它加入后台应用并配置相应 API 例外。

代码校验 Access JWT 的签名、签发团队、后台应用 AUD 和有效期，不能通过伪造邮箱头绕过。`/v1beta/*`、`/mcp`、`/api/*`、探针和页面默认受 Access 保护；本次只对 `/v1/*` 开放应用 Key 访问。后续若需要公开其他协议入口，再明确添加路径和 Access 例外。

参考：[Access 路径优先级](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)、[JWT 校验](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## 本地开发与验证

复制 `.dev.vars.example` 为 `.dev.vars` 并填入配置。本地后台也要求有效 Access JWT，没有开发绕过开关；无真实身份时使用下面的自动化集成测试验证后台：

```bash
npm run dev:cloudflare
```

本地 AI 绑定可能使用远程 Workers AI；不要把手动调试误认为不消耗额度。自动化测试注入模拟 AI 和 Groq 上游，不使用真实凭证或真实推理服务。

```bash
npm run test:cloudflare
npm run typecheck:cloudflare
npx wrangler deploy --dry-run
```

集成测试在真实 workerd + SQLite Durable Object 中验证全量迁移、嵌套事务、命名参数、初始化保护、管理员/应用鉴权隔离、Key 禁用、普通与流式推理、Responses、Groq 转发、Cloudflare 故障后回退到 Groq、重启后 Access 登录可用及 Key/额度保留及 Alarm 续订。类型生成文件和构建产物不提交。

完整上游回归由原有 `.github/workflows/ci.yml` 执行；新增 `cloudflare.yml` 验证 Cloudflare 专用构建和运行时。测试替身位于 `cloudflare/test/entry.ts`，不导出到部署产物。

## Cloudflare 运行边界

- 面向一个管理员维护的个人/小规模网关。用一个 Durable Object 保持上游全局缓存、并发租约、SQLite 状态一致；没有实现多租户或跨对象水平分片。容量和延迟受单个 DO 及 Workers 限制，不能据此声称已完成高并发生产压测。
- 免费 Provider 与 Cloudflare 服务各自有额度和使用规则；此改造不保证所有运行、存储、日志和 AI 调用永久免费。
- 本机文件备份、桌面/Git 自更新、系统代理发现、SOCKS/HTTP CONNECT 代理和原生 sharp 图像压缩不在 Workers 运行目标中。后台隐藏这些本机入口，备份/更新接口返回明确的 501。图片原始内容继续传递给上游。
- 外部 HTTPS Provider 和 Fetch Relay 可使用；不能从 Workers 访问家里或办公网的 localhost/LAN Provider。每 Key 本机代理设置会被拒绝。需要 Fetch Relay 时使用原有配置接口 `/api/settings/proxy`（`proxyMode: "fetch-relay"`），并将其作为承载上游凭证的受信服务管理。
- 数据恢复使用 Cloudflare 的 Durable Object SQLite 恢复能力，不使用上游本地文件备份按钮。首次接入不自动导入已有桌面数据库；现有生产数据迁移应单独验证。
- 管理身份由 Access 验证；普通 API 使用 Workers Rate Limiting Binding 和 DO 内存限流（240 次/分钟），不写 SQLite。DO 内存计数会随重建清空；共享出口的应用共享 IP 预算。Provider 自身的额度约束仍独立生效。
- 未使用真实 Google/Groq/NVIDIA/Cloudflare 凭证执行生产验收。应在部署后各做一笔低额度的真实调用，再开放给实际应用。

Cloudflare 官方参考：[Node HTTP/Express 接入](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)、[SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Workers AI 绑定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)。

架构决策和后续同步方法见 [ARCHITECTURE.md](ARCHITECTURE.md)。

后台退出按钮跳转到 `/cdn-cgi/access/logout`。更改登录邮箱、密码和访问权限请在 Access/身份提供商管理；本地注册、登录、重置与修改密码接口在 Workers 返回 `access_managed`。复制、导出 Provider 凭证使用 Access 验证，无本地密码步骤。旧账号数据不删除，但不能再通过本地密码登录 Cloudflare 后台。


## SQL 资源优化与 Catalog 管理

新功能的使用、MCP 身份验证、数据所有权和 SQL 对比测试见 [RESOURCE-CATALOG.md](RESOURCE-CATALOG.md)。
管理地址：`https://llm.api.happyfirst.top/models/catalog`。升级现有 Worker 即可，无需删除 Worker 或数据库。

### Settings: MCP connection and Catalog integration

Settings now displays two addresses derived from the current dashboard origin and
base path (no hard-coded hostname):

- `/api/catalog/mcp`: administrator Catalog tools, with the same Access protection
  as the dashboard. The connection test sends only `initialize` and `tools/list`,
  checks JSON-RPC errors, rejects login redirects, and times out after 15 seconds.
- `/mcp`: gateway introspection and routing tools. Enable it in Keys → Agent
  compatibility; it requires the unified Bearer API key **and**, on this deployment,
  the outer Access authentication.

Use a Streamable HTTP client, not a browser GET. The browser connection test only
verifies the current administrator session. Remote clients need their own Access
access; this app does not implement an OAuth onboarding flow for ChatGPT. Do not
bypass Access on the Catalog management endpoint to make a client connect.

Catalog's installation column is derived without writes or active probes: a model
must be enabled and have an enabled, healthy/unknown credential matching its
platform, endpoint key ID (if present), and model scope. It is configuration status,
not proof of current quota, cooldown expiry, profile selection, or successful
inference. Credential metadata is fetched once per listing; no secrets are returned
and this volatile status is excluded from Catalog edit revisions.

The web dashboard/login brand and favicon use `client/public/logo.png`. Premium is
hidden from navigation and command search; Catalog signed update logic is retained.
