# Cloudflare adaptation design

Baseline: `tashfeenahmed/freellmapi`, commit `65c7d2f9293360bc49a7ad45d02bb7d5360ff6c6`.

## Repository analysis and migration phases

| Area | Existing implementation | Cloudflare treatment |
|---|---|---|
| HTTP / dashboard API | `server/src/app.ts`, Express; authenticated admin routes | Reuse app through Cloudflare's Node HTTP bridge, skip filesystem asset serving |
| Upstream providers | `server/src/providers`, provider registry, Google/native formats and OpenAI-compatible adapters | Reuse all adapters; register a Cloudflare subclass for the native binding |
| Model intelligence | Bundled SQL model seed, signed Catalog sync, overrides and retirement | Reuse migrations, signature checks, tier rules and overrides; invoke sync from alarms |
| Routing / fallback | Scoring, profiles, per-key leases, retries, circuit/cooldown state, fallback loop | Reuse without a parallel routing implementation; all requests enter one named DO |
| Persistence | Synchronous `Db` interface, SQLite statements, named bindings, transactions | Implement the existing interface with synchronous DO SQL and `transactionSync` |
| Credentials | AES-GCM provider keys, hashed sessions/client keys, administrator setup | Reuse crypto/auth; inject encryption Secret; verify Access JWT for dashboard/setup |
| Protocols | Chat Completions, Responses, Anthropic, Gemini, Ollama, MCP | Original inference routes bundled; Catalog adds a stateless administrator MCP endpoint |
| Web UI | React/Vite client, Provider and client-profile management | Same app via static assets; compile-time runtime notice and local-feature isolation |
| Background work | Process scheduler, startup hooks, cache restore | Persistent DO Alarm, durable due timestamps, existing service functions |
| Native / local-only | sharp, better-sqlite3, filesystem backup, child process updates, proxy agents | Not used on Workers; optional native package aliases throw clearly; local UI/actions isolated |
| Existing Node/desktop | Workspaces and desktop shell | Retained as upstream source and still buildable; excluded from Workers entrypoint |

Implementation phases:

1. Analyze runtime boundaries, database contract, provider registration, authentication, background jobs, dashboard entrypoints and existing tests.
2. Add the Cloudflare entrypoint, DO driver, HTTP bridge, native AI subclass, persistent maintenance and deployment configuration.
3. Validate migrations, data lifetime, protocol streaming, auth and key management, provider transport and fallback in workerd. Isolate unsupported UI actions, document deployment and add CI.
4. Commit the adaptation on a dedicated branch. Production deployment/real-credential acceptance is a separate operation requiring the account's deployment credentials and Secrets.

## Why a SQLite Durable Object instead of D1

The server already expresses SQL access as synchronous `prepare().get/all/run` and synchronous nested transactions. D1's asynchronous calls would require propagating async signatures through routing, model selection, authentication, accounting, Catalog and protocol handlers. Retaining synchronous SQL in a DO avoids that invasive rewrite and keeps reservation decisions and persisted updates in the same coordinator.

A DO is a Workers runtime with persistent state, not a VPS or a Cloudflare Container. The public Worker forwards only API traffic to one constant object ID; static assets are served directly. No upstream URL, API key or request header can choose another object ID. The constructor rejects other IDs because upstream services use module-level caches. Do not repurpose this class as a multi-tenant namespace without first moving those globals into explicit per-instance state.

In-flight leases are intentionally memory-only: active requests cannot survive an isolate restart. Recorded usage and cooldowns remain in SQL. Ordinary admission uses the Workers Rate Limiting binding plus a bounded DO memory fallback; Access protects administrator authentication. Admission does not write SQLite. Browser assets keep the upstream bootstrap CSP hash; API responses are not cached.

## Compatibility seams

Only small host hooks are added to upstream modules:

- `bindDb` supplies a host-owned synchronous database.
- `res.locals.hostAdmin` supplies a verified Access administrator to the existing dashboard guard and credential reveal/export endpoints. Node/desktop retain their session and password checks.
- The Cloudflare timeout policy is protected for reuse, and Provider `register` is exported to allow the host to replace the Cloudflare adapter.
- Media byte arrays are expressed as `Uint8Array` for Workers/DOM Blob type compatibility.
- Client compile-time checks hide local-only controls in Cloudflare builds.

Cloudflare build also maps the small Ajv compiler interface used by tool argument validation to `@cfworker/json-schema` (interpreted Draft 2020-12). This avoids forbidden dynamic code generation while retaining the existing validation toggle, fail-open behavior for unsupported schemas and fallback handling. Format assertions remain disabled, as upstream specifies.

The Workers build directly imports source modules. It does not copy a second Provider/Catalog/router tree. Optional native dependencies are excluded by `cloudflare/build.mjs`, never by replacing the business services.

DO SQL accepts positional parameters, so the adapter tokenizes named bindings while preserving quoted strings and comments. The upstream endpoint-identity migration uses transaction-local `CREATE TEMP TABLE "_endpoint_identity_*"`; DO SQL disallows TEMP databases. Those specific statements become regular tables that the unchanged migration drops in the same transaction. Do not broaden this into an unrestricted SQL rewrite. Workerd tests verify the full migration set and nested rollback semantics.

AI binding results may be OpenAI-shaped or the older `{response}` format. Only that native output boundary is normalized. Existing HTTP Cloudflare credentials retain the original provider implementation; other Provider modules are unchanged. The SSE converter supports split UTF-8 frames and emits a terminal completion only after the native DONE marker.

Alarms re-arm before asynchronous maintenance so a failed job does not stop future wakeups. Jobs run independently with errors recorded; periodic timestamps survive eviction. Catalog signature and entitlement handling stay upstream-owned. Diagnostics distinguish an installed AI binding from a successful real inference; the native key's health check does not spend inference quota.

## Upstream synchronization

Keep the original upstream history and MIT attribution. Work from a clean branch:

```bash
git remote add upstream https://github.com/tashfeenahmed/freellmapi.git
git fetch upstream
git switch -c sync/upstream-YYYY-MM-DD
git merge upstream/main
npm ci
npm test
npm run test:cloudflare
npm run typecheck:cloudflare
npx wrangler deploy --dry-run
```

If `upstream` already exists, verify its URL instead of adding it again. Resolve only the small host hooks and client runtime checks; never discard upstream migration history. Inspect new filesystem/native imports, SQL migration constructs and scheduler behavior. Review the bundle metadata and the generated configuration whenever bindings change. Merge the sync branch only after both the existing CI and Cloudflare CI pass. No unattended merge or automatic production deployment is installed by this change.

## Validation limits

Automated integration uses real workerd/DO SQLite with synthetic AI and Groq responses. It establishes transport, route and persistence behavior; it cannot establish each vendor's live credentials, quotas, current models or production availability. Retaining all protocol modules is not equivalent to exhaustive acceptance testing of every vendor/modality combination. No claims of production load-test results are made.

## Dashboard Access

Cloudflare no longer accepts SETUP_CODE. Both public Worker and DO ingress verify Access JWTs for all paths except the explicit `/v1` namespace, using pinned jose, issuer, audience, RS256 and required expiry. The host supplies an Express admin local only after verification; request headers/body cannot set it. Cloudflare auth status uses verified JWT identity, local account routes are disabled, and no local user/session is created. Cross-site browser writes are rejected because Access authenticates with cookies. Path-scoped Access bypass for `/v1/*` preserves application-key-only calls. Integration tests sign local RSA JWTs and mock only the trusted JWKS endpoint; production verification is unchanged.


## September resource/catalog extension

See [RESOURCE-CATALOG.md](RESOURCE-CATALOG.md). Resource policy is host opt-in through
`server/src/lib/runtime-policy.ts`; Node/Docker retain their analytics/logging defaults.
The only routing query change substitutes a union of historical/error requests and
compact successful routing events. Its fields, time windows, decays, per-key scopes
and scoring math are unchanged. There is no D1 migration, extra Gateway, new provider,
or change to the Express bridge / LLM streaming lifecycle.

Catalog management edits the existing model tables. `catalog_annotations` only holds
optional intelligence and deletion ownership; it is not a second model registry.
`catalog_history` retains at most 100 administrative/sync events. Sync takes one
ownership snapshot before applying or pruning any catalog category. Maintain this
protection whenever adding future catalog categories or upstream migrations.
