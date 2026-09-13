# FreeLLMAPI on Cloudflare

本仓库在 FreeLLMAPI 上增加 Cloudflare 运行目标，保留上游 Node/桌面源码以便继续同步。部署到 Cloudflare 的内容不包含桌面应用，也不依赖 VPS、容器或外部 Node 服务。

运行路径：**Workers → 一个 SQLite Durable Object → 原有 Express 路由、Provider、Catalog、Fallback 和额度引擎**。原有 React 管理后台通过 Workers Static Assets 提供。

## 功能

- 上游凭证：沿用“平台密钥”页面，支持 Google、Groq、NVIDIA、Cloudflare 和上游已有 Provider；状态、模型范围、启用/禁用与路由规则沿用原实现。
- 下游接口：沿用“API 密钥”页面中的客户端配置，创建、禁用、轮换、删除各应用独立 Key。应用 Key 不能访问管理 API。
- OpenAI Chat Completions、流式 SSE、Responses，以及原有 Anthropic、Gemini、Ollama 协议路由保留。各模型实际支持的模态、工具与参数仍取决于 Provider。
- Cloudflare Workers AI：首次初始化生成名为 `Workers AI (native binding)` 的凭证记录，调用 `AI.run()`，无需另存本账户的 API Token。可在后台禁用或删除；之后启动不会重新创建。其他账户仍可按上游格式 `account_id:api_token` 添加，走原 REST Provider。
- 数据：凭证密文、会话、应用 Key、模型、Catalog、额度使用、冷却、路由配置、请求日志和缓存保存在 Durable Object SQLite。
- 维护：Durable Object Alarm 每 5 分钟唤醒，执行健康检查、冷却恢复和清理；Catalog 每 12 小时检查，Custom Model 同步每 6 小时检查。调度不依赖用户访问，也不依赖 `setInterval`。保留 Catalog 签名检查和原有免费/付费目录规则。

## 部署

使用 Node.js 22 或 24（建议 24）。Wrangler 版本已锁定。

```bash
npm ci
npx wrangler login
```

分别生成两个不同的随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

设置为 Worker Secrets；每条命令会提示输入，若 Worker 尚不存在，按 Wrangler 提示创建：

```bash
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SETUP_CODE
npm run deploy:cloudflare
```

- `ENCRYPTION_KEY` 必须为 64 位十六进制值；保存好，丢失后无法解密已有 Provider 凭证。不要用普通环境变量或提交到仓库。更换它不是普通配置修改，需要迁移旧密文。
- `SETUP_CODE` 至少 24 个字符，首次打开后台创建管理员时填写。即使 HTTP 桥接层报告 localhost，也不能绕过此校验。
- 未正确设置 Secrets 时，管理和推理服务拒绝启动，避免公开部署被抢先注册。
- `wrangler.jsonc` 中已经声明 `GATEWAY` SQLite Durable Object、`AI` 和 `ASSETS` 绑定及首次迁移；不需要 D1 数据库 ID。Wrangler 自动构建后部署。
- 保持 Worker 名称、`Gateway` 类名、`primary` 对象名和迁移历史稳定。更改它们可能指向新数据库。
- `keep_vars` 保留控制台设置的普通变量；绑定仍由 `wrangler.jsonc` 管理。若自行添加绑定，应同时写入配置，不能假设部署会保留未声明的绑定。

打开部署产生的 HTTPS 地址，输入 Setup Code 注册管理员，然后在平台密钥页加入需要的上游凭证，在 API 密钥页创建应用 Key。

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

可用模型由 `GET /v1/models` 查询。`auto` 使用后台选定的路由和回退配置。

## 本地开发与验证

复制 `.dev.vars.example` 为 `.dev.vars` 并填入本地专用 Secrets：

```bash
npm run dev:cloudflare
```

本地 AI 绑定可能使用远程 Workers AI；不要把手动调试误认为不消耗额度。自动化测试注入模拟 AI 和 Groq 上游，不使用真实凭证或真实推理服务。

```bash
npm run test:cloudflare
npm run typecheck:cloudflare
npx wrangler deploy --dry-run
```

集成测试在真实 workerd + SQLite Durable Object 中验证全量迁移、嵌套事务、命名参数、初始化保护、管理员/应用鉴权隔离、Key 禁用、普通与流式推理、Responses、Groq 转发、Cloudflare 故障后回退到 Groq、重启后会话/Key/额度保留及 Alarm 续订。类型生成文件和构建产物不提交。

完整上游回归由原有 `.github/workflows/ci.yml` 执行；新增 `cloudflare.yml` 验证 Cloudflare 专用构建和运行时。测试替身位于 `cloudflare/test/entry.ts`，不导出到部署产物。

## Cloudflare 运行边界

- 面向一个管理员维护的个人/小规模网关。用一个 Durable Object 保持上游全局缓存、并发租约、SQLite 状态一致；没有实现多租户或跨对象水平分片。容量和延迟受单个 DO 及 Workers 限制，不能据此声称已完成高并发生产压测。
- 免费 Provider 与 Cloudflare 服务各自有额度和使用规则；此改造不保证所有运行、存储、日志和 AI 调用永久免费。
- 本机文件备份、桌面/Git 自更新、系统代理发现、SOCKS/HTTP CONNECT 代理和原生 sharp 图像压缩不在 Workers 运行目标中。后台隐藏这些本机入口，备份/更新接口返回明确的 501。图片原始内容继续传递给上游。
- 外部 HTTPS Provider 和 Fetch Relay 可使用；不能从 Workers 访问家里或办公网的 localhost/LAN Provider。每 Key 本机代理设置会被拒绝。需要 Fetch Relay 时使用原有配置接口 `/api/settings/proxy`（`proxyMode: "fetch-relay"`），并将其作为承载上游凭证的受信服务管理。
- 数据恢复使用 Cloudflare 的 Durable Object SQLite 恢复能力，不使用上游本地文件备份按钮。首次接入不自动导入已有桌面数据库；现有生产数据迁移应单独验证。
- 管理认证额外有持久化的 IP 窗口限制（20 次/15 分钟），其他 API 为 240 次/分钟，再叠加上游自身限制。部署重启不会清空这层限制；共享出口的应用共享 IP 预算。
- 未使用真实 Google/Groq/NVIDIA/Cloudflare 凭证执行生产验收。应在部署后各做一笔低额度的真实调用，再开放给实际应用。

Cloudflare 官方参考：[Node HTTP/Express 接入](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)、[SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Workers AI 绑定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)。

架构决策和后续同步方法见 [ARCHITECTURE.md](ARCHITECTURE.md)。
