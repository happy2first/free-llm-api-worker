import { configureRuntime, recentHealthyKeys } from '../../server/src/lib/runtime-policy.js';
import { ResourceMetrics } from './telemetry.js';
import { decodeJwt } from 'jose';
import { accessGuard, applicationApi } from './access.js';
import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import { createApp, INLINE_BOOTSTRAP_SHA } from '../../server/src/app.js';
import { bindDb, getDb, getSetting, setSetting } from '../../server/src/db/index.js';
import { runMigrationsSync } from '../../server/src/db/migrate/runner.js';
import { initEncryptionKey, encrypt } from '../../server/src/lib/crypto.js';
import { installLogRedaction } from '../../server/src/lib/log-redaction.js';
import { loadConfig } from '../../server/src/lib/config.js';
import { register } from '../../server/src/providers/index.js';
import { restoreProxySettings, getProxyMode } from '../../server/src/lib/proxy.js';
import { loadCacheFromDb } from '../../server/src/services/cache.js';
import { cleanupExpiredCooldowns } from '../../server/src/services/ratelimit.js';
import { syncCatalog, refreshLicenseStatus, reapplyCachedCatalog } from '../../server/src/services/catalog-sync.js';
import { checkAllKeys } from '../../server/src/services/health.js';
import { runCooldownProbePass } from '../../server/src/services/cooldown-probe.js';
import { runCustomModelSync } from '../../server/src/services/custom-model-sync.js';
import { pruneRequestAnalytics } from '../../server/src/services/request-retention.js';
import { Admission } from './security.js';
import { durableSqlite } from './sqlite.js';
import { NativeCloudflareProvider, NATIVE_AI_KEY, type AiBinding } from './ai.js';

export interface Env {
  GATEWAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: AiBinding;
  ENCRYPTION_KEY: string;
  TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  REQUEST_ANALYTICS?: AnalyticsEngineDataset;
  API_RATE_LIMITER?: RateLimit;
}
configureRuntime({ cloudflare: true });
installLogRedaction();
const OBJECT_NAME = 'primary';
const PORT = 8788;
const clientSignals = new AsyncLocalStorage<AbortSignal>();
// node:http's port registry lives for the isolate, not the Durable Object.
// An object can be reconstructed while its previous listener is still alive.
// Register once and replace the app after each successful object initialization
// so requests use the current database/provider bindings, never an old instance.
let gatewayApp: ReturnType<typeof express> | undefined;
const server = createServer((req, res) => {
  if (!gatewayApp) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { type: 'gateway_unavailable', message: 'Gateway is initializing' } }));
    return;
  }
  gatewayApp(req, res);
});
server.listen(PORT);
const apiPath = (path: string) => /^\/(api|v1|v1beta|mcp)(\/|$)/.test(path) || ['/livez', '/readyz'].includes(path);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/livez') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    const denied = await accessGuard(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (!apiPath(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'same-origin');
      headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' ${INLINE_BOOTSTRAP_SHA}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
      if (headers.get('content-type')?.includes('text/html')) headers.set('Cache-Control', 'no-cache');
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (env.API_RATE_LIMITER) {
      const { success } = await env.API_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
      if (!success) return Response.json({ error: { type: 'rate_limit_error', message: 'Too many requests' } }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    const headers = new Headers(request.headers);
    // Replace untrusted forwarding headers at the only public entrypoint.
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '192.0.2.1');
    headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
    headers.delete('forwarded');
    return env.GATEWAY.get(env.GATEWAY.idFromName(OBJECT_NAME)).fetch(new Request(request, { headers }));
  },
};

export class Gateway extends DurableObject<Env> {
  private ready: Promise<void>;
  private admission = new Admission();
  private metrics: ResourceMetrics;
  private lastPrune = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.metrics = new ResourceMetrics(env.REQUEST_ANALYTICS);
    configureRuntime({ cloudflare: true, emit: this.metrics.emit });
    recentHealthyKeys.clear();
    // Upstream has process-wide caches. This is a single-admin installation,
    // intentionally one named object. Never create a DB per API key or caller.
    if (!ctx.id.equals(env.GATEWAY.idFromName(OBJECT_NAME))) throw new Error('Only the primary gateway object is supported');
    this.ready = ctx.blockConcurrencyWhile(async () => {
      if (!/^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY ?? '')) throw new Error('Set ENCRYPTION_KEY to 64 hex characters');
      process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
      process.env.IMAGE_NORMALIZE = 'off';
      bindDb(durableSqlite(ctx.storage, this.metrics.recordSql));
      runMigrationsSync(getDb());
      getDb().exec(`CREATE TABLE IF NOT EXISTS cloudflare_routing_events (
        platform TEXT NOT NULL, model_id TEXT NOT NULL, key_id INTEGER,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL, ttfb_ms INTEGER, request_type TEXT NOT NULL DEFAULT 'chat',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ); CREATE INDEX IF NOT EXISTS idx_cf_routing_time ON cloudflare_routing_events(created_at);`);
      initEncryptionKey(getDb());
      // Migrations are tracked; reapply only when that set changes, not every eviction.
      const migrationStamp = JSON.stringify(getDb().prepare('SELECT * FROM migrations').all());
      if (getSetting('cloudflare_catalog_migration_stamp') !== migrationStamp) {
        reapplyCachedCatalog();
        setSetting('cloudflare_catalog_migration_stamp', migrationStamp);
      }
      restoreProxySettings();
      loadCacheFromDb();
      cleanupExpiredCooldowns();
      register(new NativeCloudflareProvider(env.AI));
      // Seed once; an administrator can disable or delete this row permanently.
      if (!getSetting('cloudflare_native_seeded')) {
        const key = encrypt(NATIVE_AI_KEY);
        getDb().prepare(`INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, label, status) VALUES (?, ?, ?, ?, ?, ?)`)
          .run('cloudflare', key.encrypted, key.iv, key.authTag, 'Workers AI (native binding)', 'healthy');
        setSetting('cloudflare_native_seeded', '1');
      }
      const app = express();
      app.use('/api/auth/setup', express.json({ limit: '16kb' }));
      app.use(['/api/settings/proxy', '/api/keys'], express.json({ limit: '10mb' }));
      app.use((req, res, next) => {
        res.locals.hostClientSignal = clientSignals.getStore();
        // Gateway.fetch verifies Access before passing any admin request here.
        if (!applicationApi(req.path)) {
          // JWT signature/issuer/audience/expiry were checked by Gateway.fetch.
          const identity = decodeJwt(req.headers['cf-access-jwt-assertion'] as string);
          res.locals.hostAdmin = { userId: 0, email: typeof identity.email === 'string' ? identity.email : identity.sub };
        }
        if (/^\/api\/auth(?:\/|$)/i.test(req.path)) {
          if (req.method === 'GET' && ['/api/auth/status', '/api/auth/me'].includes(req.path)) {
            res.json({ needsSetup: false, authenticated: true, email: res.locals.hostAdmin.email });
          } else {
            res.status(409).json({ error: { message: 'Administrator identity is managed by Cloudflare Access', type: 'access_managed' } });
          }
          return;
        }
        if (req.body?.proxyUrl && (req.path.startsWith('/api/keys') ||
          (req.path.startsWith('/api/settings/proxy') && (req.body.proxyMode ?? getProxyMode()) !== 'fetch-relay'))) {
          res.status(400).json({ error: { message: 'Cloudflare supports direct HTTPS or Fetch Relay; local forward/SOCKS proxies are unavailable', type: 'runtime_unsupported' } });
          return;
        }
        if (/^\/api\/(backups|update)(\/|$)/.test(req.path)) {
          res.status(501).json({ error: { message: 'Use Cloudflare deployment and Durable Object recovery tools for this operation', type: 'runtime_unsupported' } });
          return;
        }
        next();
      });
      const config = { ...loadConfig(), serveStaticAssets: false, trustProxy: true };
      app.get('/api/runtime/resources', (_req, res) => res.json(this.metrics.snapshot()));
      app.use(createApp(config));
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 10_000);
      gatewayApp = app;
    });
  }
  async fetch(request: Request) {
    const denied = await accessGuard(request, this.env);
    if (denied) return denied;
    await this.ready;
    if (!this.admission.admit(request.headers.get('x-forwarded-for') ?? 'unknown')) {
      return Response.json({ error: { message: 'Too many requests', type: 'rate_limit_error' } }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    const client = new AbortController();
    const abort = () => client.abort(new DOMException('Client disconnected', 'AbortError'));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    const response = await clientSignals.run(client.signal, () => handleAsNodeRequest(PORT, request));
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    if (response.body && headers.get('Content-Type')?.includes('text/event-stream')) {
      // Keep the producer alive until consumption ends. Fetch cancellation is
      // authoritative here; the Node shim's close event is not a socket signal.
      const reader = response.body.getReader();
      let finish!: () => void;
      this.ctx.waitUntil(new Promise<void>(resolve => {
        finish = () => { request.signal.removeEventListener('abort', abort); resolve(); };
      }));
      const readable = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); finish(); }
            else controller.enqueue(value);
          } catch (error) { controller.error(error); finish(); }
        },
        async cancel(reason) {
          abort();
          finish();
          await reader.cancel(reason);
        },
      });
      return new Response(readable, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  }
  async alarm() {
    await this.ready;
    // Arm before work: eviction/failure cannot silently stop maintenance.
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
    const jobs: Array<[string, () => Promise<unknown>]> = [
      ['health', () => checkAllKeys()],
      ['cooldowns', () => runCooldownProbePass()],
    ];
    if (Date.now() - Number(getSetting('cloudflare_catalog_at') ?? 0) >= 12 * 3600_000) {
      jobs.push(['catalog', async () => {
        if (process.env.CATALOG_SYNC_DISABLED === '1') return;
        await refreshLicenseStatus();
        const result = await syncCatalog();
        setSetting('cloudflare_catalog_at', String(Date.now()));
        return result;
      }]);
    }
    if (Date.now() - Number(getSetting('cloudflare_custom_at') ?? 0) >= 6 * 3600_000) {
      jobs.push(['custom-models', async () => {
        await runCustomModelSync(getDb());
        setSetting('cloudflare_custom_at', String(Date.now()));
      }]);
    }
    for (const [name, run] of jobs) {
      try { await run(); }
      catch { console.error(`[cloudflare] ${name} maintenance failed`); }
    }
    cleanupExpiredCooldowns();
    if (Date.now() - this.lastPrune >= 3600_000) {
      pruneRequestAnalytics({ force: true });
      getDb().prepare("DELETE FROM cloudflare_routing_events WHERE created_at < MIN(datetime('now', 'start of month'), datetime('now', '-7 days'))").run();
      this.lastPrune = Date.now();
      console.info('[cloudflare-resources]', JSON.stringify(this.metrics.snapshot().sql));
    }
    getDb().prepare('DELETE FROM sessions WHERE expires_at_ms < ?').run(Date.now());
  }
}
