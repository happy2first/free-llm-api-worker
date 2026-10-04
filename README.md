# FreeLLMAPI Worker

**A personal AI API gateway on Cloudflare: connect upstream providers, call a unified API, and manage the gateway through a web dashboard.**

**English** · [简体中文](README.zh-cn.md) · [Deployment guide](cloudflare/README.md) · [Catalog and resources](cloudflare/RESOURCE-CATALOG.md)

Based on [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), this fork reuses its providers, catalog, routing, fallback and quota management on Cloudflare Workers. It requires no VPS, Docker container or separate Node server.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Preserved upstream desktop / Node version and synchronization source |
| `cloudflare/workers-runtime` | Independently maintained Cloudflare version; deploy this branch |

Cloudflare deployment stays on `cloudflare/workers-runtime`. Merging into `main` is not a release step. Desktop installation instructions do not apply to Workers. Review and validate Workers compatibility when bringing in upstream updates.

## Features

- **Unified inference:** OpenAI-compatible Chat Completions, SSE streaming and Responses; explicit model selection or configured `auto` routing.
- **Routing and fallback:** reuse upstream model selection, rate limits, cooldowns, health checks and quota state.
- **Credentials and application keys:** encrypted upstream credentials; separate downstream API keys with model permissions, disable, rotation and deletion controls.
- **Workers AI:** native `AI.run()` for the current account; REST access to other accounts through `account_id:api_token`.
- **Web dashboard:** manage credentials, models, routing, application keys, Catalog and resources; administrator identity comes from Cloudflare Access.
- **Catalog:** browsing, filtering, sorting, editing, signed update checks and history, with official/user/AI ownership.
- **Management MCP:** read and edit Catalog records and register dynamic OpenAI-compatible chat providers. Provider registration, model creation and credential setup are separate steps.
- **Resource controls:** Analytics Engine for successful request analytics, compact SQLite routing records, SQL diagnostics, storage usage and a configurable cleanup target.
- **Persistent maintenance:** DO Alarm maintenance every five minutes, Catalog checks every twelve hours and Custom Model synchronization every six hours.

Embedding, image and audio capabilities depend on existing adapters, models and credentials. The dynamic MCP provider adapter currently supports OpenAI-compatible chat only. SiliconFlow Global (`siliconflow`) and China (`siliconflow-cn`) have separate endpoints, credentials and model identities.

## Architecture

Workers forwards API requests to one SQLite Durable Object named `primary`, which reuses Express routes and providers. Workers Static Assets serves the React dashboard.

| Component | Purpose |
| --- | --- |
| Workers | Entry point, Access verification, rate limiting and static assets |
| `GATEWAY` / `Gateway` | Single SQLite DO for credentials, application configuration, Catalog, quotas, routing and conversations |
| `AI` | Native Workers AI inference |
| `ASSETS` | Web dashboard |
| `REQUEST_ANALYTICS` | Analytics Engine request / attempt events |
| `API_RATE_LIMITER` | Request admission |

No D1 database is required. This is a personal / small-scale gateway, with no multi-tenant isolation or cross-DO sharding.

## Deployment

### 1. Check out the Cloudflare branch

Use Node.js 22 or 24; 24 is recommended.

```bash
git clone --branch cloudflare/workers-runtime --single-branch https://github.com/happy2first/free-llm-api-worker.git
cd free-llm-api-worker
npm ci
npx wrangler login
```

### 2. Configure the runtime

| Name | Type | Value |
| --- | --- | --- |
| `ENCRYPTION_KEY` | Worker Secret | 64 hexadecimal characters |
| `TEAM_DOMAIN` | Runtime variable | Access team domain, e.g. `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | Runtime variable | Audience of the administrator Access application |

For a new instance, generate and securely retain an encryption key, then enter it at the Secret prompt:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put ENCRYPTION_KEY
```

Keep the existing key when upgrading. Changing it requires ciphertext migration; losing it prevents decryption of stored credentials. There is no `SETUP_CODE` or local administrator setup.

The current `wrangler.jsonc` declares Analytics Engine. Enable the service in the target account before deploying, or set `analytics_engine_datasets` to `[]`. Inference still works without that binding, but recent events remain in memory rather than persistent analytics.

### 3. Configure Cloudflare Access

Create two self-hosted Access applications for the hostname you will use:

| Application | Path | Policy |
| --- | --- | --- |
| Admin | Entire hostname | Allow only administrator identities |
| API | Same hostname, `v1/*` | Bypass / Everyone |

Set `ACCESS_AUD` to the Admin application's audience. API Bypass skips Access only; application API-key validation remains active. Do not bypass the entire hostname or management API. Every identity admitted to the Admin application has administrator privileges.

### 4. Deploy and configure the gateway

```bash
npm run deploy:cloudflare
```

For Cloudflare Git builds, use production branch `cloudflare/workers-runtime`, root `/`, build command `npm run build:cloudflare`, and deploy command `npx wrangler deploy --config wrangler.jsonc`. See the [deployment guide](cloudflare/README.md) for details.

Sign in through Access, add upstream credentials, confirm models and routing, then create a downstream application key. The native Workers AI credential is seeded once; disabling or deleting it is respected on later starts.

Preserve the Worker name, `Gateway` class, `primary` object name, migration history and encryption key across upgrades. Do not delete the Worker or database to update it.

## API usage

Configure an OpenAI-compatible client with:

- Base URL: `https://YOUR-DOMAIN/v1`
- API key: a **downstream application key** created in the dashboard, not a provider credential
- Model: an ID returned by `GET /v1/models`, or `auto` after configuring routing and fallback

```bash
curl https://YOUR-DOMAIN/v1/models \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY'

curl https://YOUR-DOMAIN/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_APPLICATION_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

For SSE, set `stream` to `true` and add `-N` to curl.

Smoke-test authentication first: an incognito dashboard visit goes through Access; `/v1/models` returns JSON 401 without a key and 200 with a valid key; an application key cannot access management APIs. Then test a specific model with real non-streaming and streaming calls before testing `auto`.

## MCP and Catalog

| Endpoint | Purpose | Authentication |
| --- | --- | --- |
| `/api/catalog/mcp` | Catalog and provider management | Administrator Access identity |
| `/mcp` | Gateway introspection and routing | Agent compatibility enabled, plus Access and gateway Bearer-key validation |

Use a Streamable HTTP client. Settings derives connection URLs from the current dashboard origin. A browser connection test verifies the current administrator session, not an external client's connection. This project does not implement ChatGPT OAuth onboarding.

For a dynamic upstream: register the provider, add exact model IDs under the same platform ID, add its credential, and test inference. A Catalog entry does not implement an adapter or automatically import the provider's model list. The installation indicator reports configuration, not current inference availability or free quota.

See [Catalog ownership, MCP and resource management](cloudflare/RESOURCE-CATALOG.md).

## Validation and check status

```bash
npm run test:cloudflare
npm run typecheck:cloudflare
npx wrangler deploy --dry-run

# Upstream Node / CLI / frontend regression checks
npm run test:migrations
npm test
npm run lint
npm run build
```

Cloudflare integration tests run real workerd and DO SQLite with mocked AI, Groq and Access services, without real inference credentials. Dry-run builds and packages the Worker; it does not deploy. If the server suite fails, the later CLI / frontend suites may not have run.

At the documentation baseline `a5556d30` (2026-09-18), [Cloudflare CI](https://github.com/happy2first/free-llm-api-worker/actions/runs/35311387121) passed, while [full Node 20/22 CI](https://github.com/happy2first/free-llm-api-worker/actions/runs/35311387149) failed on SiliconFlow repair-test import paths and media-test conflicts with newly seeded data. There is a [Cloudflare deployment-success record](https://github.com/happy2first/free-llm-api-worker/pull/1#issuecomment-5660259060) for that baseline; it does not establish comprehensive real-provider acceptance or production load testing. Use commit-specific checks and live tests for later versions.

A red cross beside a GitHub commit means an associated check failed. The commit was saved; deployment has a separate outcome. Inspect the individual workflow and logs.

## Boundaries

- Models, quotas, charges and capabilities depend on each provider account. The project name does not guarantee free operation.
- The storage cleanup target defaults to 768 MiB. It removes old logs and conversations while protecting core state and recently active conversations; it is not a hard storage cap.
- Resource counters describe Gateway SQLite and in-memory diagnostics, not account-wide billing or remaining quota. Legacy Analytics pages do not include complete new success history.
- Workers does not provide desktop self-update, local file backups, LAN providers, SOCKS / HTTP CONNECT proxies or sharp image compression. External HTTPS and a trusted Fetch Relay are supported.
- Recovery uses Cloudflare DO SQLite recovery facilities. Desktop databases are not imported automatically.
- Other protocol routes are retained, but only `/v1/*` is publicly accessible using application keys by default. `/v1beta/*`, `/api/*` and MCP require Access.
- Validate each provider you intend to enable against its real account, and test single-DO capacity at your expected traffic level.

## Documentation and attribution

- [Deployment and authentication](cloudflare/README.md)
- [Architecture and upstream synchronization](cloudflare/ARCHITECTURE.md)
- [Catalog, MCP, SQL and storage policy](cloudflare/RESOURCE-CATALOG.md)
- [Upstream FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)

[MIT License](LICENSE). The upstream copyright notice for Tashfeen Ahmed is retained.
