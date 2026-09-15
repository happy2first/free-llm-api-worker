# SQL resource policy and unified Catalog

## Upgrade and use

Deploy the existing `cloudflare/workers-runtime` branch to the **same Worker**. Do not
remove the Worker, Gateway binding, SQLite object or `ENCRYPTION_KEY`. The migration
adds ownership columns/annotations/history; existing keys, profiles and overrides
remain in place. No D1, extra DO or external Node service is required.

- Dashboard: `/models/catalog` (Models → Catalog).
- Management JSON: `GET /api/catalog`; filter with `kind`, `platform`, `source`, `search`.
- Check signed monthly/live updates: `POST /api/catalog/sync` with `{}`.
- CRUD: `POST /api/catalog/records/create|update|delete|restore`.
- Resource counters: `GET /api/runtime/resources` (administrator only).
- Liveness: `GET /livez` returns at the outer Worker, before Access verification and
  without entering Gateway or SQLite. If the hostname has an Access application,
  give **only `/livez`** a path-specific Bypass for an external health monitor.
  `/api/health` remains the protected detailed health endpoint.

No new secrets are needed for the resource bindings. `wrangler.jsonc` declares:

- `REQUEST_ANALYTICS` is optional and omitted by default so accounts without Analytics Engine can deploy.
- `API_RATE_LIMITER` → namespace `2026091501`, 240 requests / 60 seconds. Use a different
  namespace if another Worker in the account already uses that number. Ordinary
  admission uses the same IP grouping as the previous implementation. Native limits
  are per Cloudflare location and eventually consistent; the Gateway also uses a
  bounded 4,096-entry memory limiter. Its counters reset on object reconstruction.
  These limits are abuse admission, **not** authoritative provider quota accounting.

Bindings and behavior: [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/get-started/).
If the Analytics Engine binding is absent, requests still work; the runtime resource page
reports `analyticsEnabled: false` and retains only the latest 100 events in memory.
There is deliberately no fallback that silently resumes expensive SQL analytics.

### Enable persistent request analytics (optional)

First enable Analytics Engine in the Cloudflare account dashboard. Then replace
the empty `analytics_engine_datasets` array in `wrangler.jsonc` with:

```json
"analytics_engine_datasets": [
  { "binding": "REQUEST_ANALYTICS", "dataset": "freellm_requests" }
]
```

Commit and redeploy. Declaring this binding before the account enables the service
causes Cloudflare to reject the deployment, even though compilation succeeds.
Without this binding, SQL savings and routing remain active, but the recent
100-event memory buffer is not a persistent analytics history.

## SQL changes and limits

| Path | Cloudflare behavior |
|---|---|
| Ordinary warn/error | Existing sanitized console + memory log ring; no `server_logs` insert, preload or clear write |
| Successful requests | Analytics Engine + one compact `cloudflare_routing_events` core row |
| Hourly/lifetime analytics | No per-request `request_hourly` or cumulative settings updates |
| Successful attempts | Analytics Engine only; no ordinary `request_attempts` success rows |
| Failed/canceled requests | Existing diagnostic `requests` rows and non-success attempts retained |
| Admission | Binding + bounded memory; no `cloudflare_admission` writes or cleanup |
| Health | Persist changed verdict/error only; recent healthy traffic suppresses scheduled probes for 30 minutes; forced checks still work |
| Cooldown | Identical expiry/source does not update its SQLite row |
| Provider quota headers | Retain exact current quota state; no duplicate ordinary observation audit row; deduplicate identical readings within 5 minutes |
| Catalog on reconstruction | Reapply cached snapshot only when migration set changes, not every object reconstruction |
| Retention | Hourly maintenance instead of request-driven pruning |
| Monthly quota display | Same complete request union; 60-second memory cache avoids repeated month scans on dashboard polling |
| SQL diagnostics | Cursor Rows Read/Written aggregated in bounded memory by operation/table; no SQL for the counters |

The exact per-request record is required because the existing router reads a 7-day
success/latency/TTFB history and current-month token sums. A static union of the old
`requests` table and compact successes supplies the **same fields and calculations**.
Compact rows have only one time index and are retained through the earlier of the
month start and seven days ago. Per-key quota reservations/usage remain durable and
unchanged. Analytics Engine is never used to make admission/routing decisions.

The workerd comparison test logs the same 10 synthetic successful requests using
both persistence policies, on the same schema:

| Request-log path only | Rows Written | Rows Read |
|---|---:|---:|
| Original Node persistence policy | 114 | 434 |
| Cloudflare compact policy | 20 | 0 |

This is approximately **82% fewer writes in that isolated logging path**, including
SQLite index writes. It is **not** an 82% reduction in total Worker usage. Real savings
depend on model count, traffic, errors, quota headers, dashboard polling and catalog
maintenance. Under Free Plan this removes several avoidable write sources; it cannot
guarantee a fixed number of free requests. Counters reset on reconstruction and are
diagnostics, not a replacement for Cloudflare billing metrics.

Legacy Analytics pages retain old history and exceptions and display a Cloudflare
notice: they no longer represent complete success totals. Recent runtime events are
visible in Catalog → MCP/Resources; long-term success analytics belong to Analytics
Engine. AE event layout:

| Field | Meaning |
|---|---|
| index1 | provider (sampling key) |
| blob1 | `request` or `attempt` |
| blob2 / blob3 / blob4 | provider / model / status or attempt outcome |
| blob5 | request modality (`chat`, `embedding`, `image`, etc.); empty for attempts |
| double1 / double2 | input / output tokens |
| double3 | latency or attempt duration, milliseconds |
| double4 | prior fallback attempts for request events; 1 for non-first attempt events |

Use sampling weights in AE queries, e.g. through the Cloudflare SQL API with a
separately scoped Account Analytics Read token:

```sql
SELECT blob2 AS provider, blob3 AS model, blob4 AS status,
       SUM(_sample_interval) AS requests,
       SUM(_sample_interval * double1) AS input_tokens,
       SUM(_sample_interval * double2) AS output_tokens,
       SUM(_sample_interval * double3) / SUM(_sample_interval) AS latency_ms
FROM freellm_requests
WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY provider, model, status
```

## Catalog ownership and editing

The page shows all current Chat/Embedding/Media/Quirk records, core fields, raw
current JSON, cached verified official JSON, version/tier/generatedAt, last check,
sync errors, and recent administrative/sync history. Fields not applicable to a
category display `—`; full category-specific values remain in the detail editor.
For new models, select the category, click **新增记录**, and fill the JSON template.
Adding a catalog entry does not implement a new Provider adapter or install a key.
Configure credentials in **密钥 → 提供方** as before. Endpoint-scoped custom models
are visible but remain editable through their existing Provider editor.

Public ownership values:

- `freellm`: official/bundled content; stored as legacy `source='catalog'`.
- `user`: manual create/replace; existing `source='user'` remains compatible.
- `ai`: MCP create/replace; assigned by the server, never trusted from caller input.

All four live model/content tables carry ownership. One optional
`catalog_annotations` row stores `origin`, an `extensions` JSON object and deletion
ownership. Suggested extension keys are `credentialRequirement`, `freeQuota`,
`requiresCreditCard`, `requiresPhone`, `requiresKyc`, `signupUrl`, `regions`, `notes`,
`evidenceLinks`. Use null for unknown facts; credentials themselves belong in the
encrypted Provider credential manager, not in catalog intelligence.

Monthly sync snapshots protected identifiers before doing any updates, retirement
reinstatement or pruning. `user`/`ai` entries and locally deleted identifiers are
excluded in every category. Existing Chat/Media tombstones and Local Override
behavior remain; an explicit takeover copies the effective values and clears that
record's older override. No confidence/source ranking resolves conflicts.

Creating over an existing identifier, updating, deleting or restoring returns HTTP
409 with `existing` and `proposed` unless the caller explicitly chooses:

- `conflict: "skip"`: leave the current row unchanged.
- `conflict: "replace"`, `expectedRevision: "<revision returned by read/conflict>"`:
  execute only if the row is still the one reviewed. A stale revision produces
  another conflict. Existing deletion markers also require explicit replace/skip.

The UI displays both records and offers **确认覆盖 / 执行** and **放弃**. Identity
renaming is deliberately a separate create/delete, not an ambiguous update.
**恢复官方版本** uses that record from the current *verified cached* official
snapshot, resets source to `freellm`, removes overrides/annotations/tombstones, and
allows future monthly updates again. It reports an error when no verified snapshot
or matching official record exists. It never applies a partial synthetic catalog.

## Catalog MCP

Endpoint: `https://llm.api.happyfirst.top/api/catalog/mcp`.
Stateless Streamable HTTP, JSON responses, protocol `2025-03-26`.
Tools: `catalog_search`, `catalog_read`, `catalog_create`, `catalog_update`,
`catalog_delete`, `catalog_restore`. Search is paginated (`offset`, `limit <= 100`).
Tools return errors with the current record; a separate caller decision must supply
`replace` plus its revision or `skip`. No tool silently upgrades its own trust.

This endpoint uses **administrator authentication**. On Cloudflare, retain Access
protection for `/api/*` including this endpoint. A downstream `/v1/*` API Key cannot
read or edit the catalog. Machine MCP clients need an Access-authorized identity
(e.g. service-token policy on the admin Access application, with the resulting
Access assertion accepted by the Worker). Do not apply Bypass to this endpoint.
Outside Cloudflare the existing dashboard bearer session is required.

Example tools/call payload after the client's normal MCP initialization:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "catalog_search", "arguments": { "search": "nvidia", "limit": 20 } }
}
```

A client integrating ChatGPT must support the configured Access authentication or
connect through an already trusted MCP gateway. This change does not introduce an
OAuth authorization server or a public master-key management endpoint. The existing
LLM/introspection `/mcp` endpoint and its enable switch are unchanged.

## Validation and upstream maintenance

`npm run test:cloudflare` tests real workerd/DO SQLite, existing streaming, actual
cancellation, concurrent dashboard calls, fallback, restart quotas, SQL budgets,
Catalog manual/AI protection in all categories, conflict/revision handling, restore,
deleted-row protection and rejection of invalid catalog signatures. Provider outputs
are mocked; no production credentials are needed.

The client suite and build run normally. Focused Node tests cover catalog sync,
quota state, router scoring, request attempts and migration up/down/reapply. Full Node
suite execution in this environment was blocked by automatic approval review because
a provider test tried to connect to `moonshot.ai.example.com` through the environment
SOCKS proxy. It is not reported as passing.

Keep the neutral `runtime-policy` opt-in and ownership guards when absorbing upstream
updates. Avoid replacing the routing union with lossy sampled analytics. No Provider,
Fallback or streaming algorithm was rewritten by this extension.
