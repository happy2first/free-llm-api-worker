import { accessGuard } from './access.js';
import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer } from 'node:http';
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
import { initAdmission, admit } from './security.js';
import { durableSqlite } from './sqlite.js';
import { NativeCloudflareProvider, NATIVE_AI_KEY, type AiBinding } from './ai.js';

export interface Env {
  GATEWAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: AiBinding;
  ENCRYPTION_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}
installLogRedaction();
const OBJECT_NAME = 'primary';
const PORT = 8788;
const apiPath = (path: string) => /^\/(api|v1|v1beta|mcp)(\/|$)/.test(path) || ['/livez', '/readyz'].includes(path);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Upstream has process-wide caches. This is a single-admin installation,
    // intentionally one named object. Never create a DB per API key or caller.
    if (!ctx.id.equals(env.GATEWAY.idFromName(OBJECT_NAME))) throw new Error('Only the primary gateway object is supported');
    this.ready = ctx.blockConcurrencyWhile(async () => {
      if (!/^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY ?? '')) throw new Error('Set ENCRYPTION_KEY to 64 hex characters');
      process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
      process.env.IMAGE_NORMALIZE = 'off';
      bindDb(durableSqlite(ctx.storage));
      runMigrationsSync(getDb());
      initAdmission(getDb());
      initEncryptionKey(getDb());
      reapplyCachedCatalog();
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
        // Gateway.fetch verifies Access before passing any admin request here.
        res.locals.hostSetupAuthorized = true;
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
      app.use(createApp(config));
      createServer(app).listen(PORT);
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 10_000);
    });
  }
  async fetch(request: Request) {
    const denied = await accessGuard(request, this.env);
    if (denied) return denied;
    await this.ready;
    const path = new URL(request.url).pathname;
    const isAuth = /^\/api\/auth\/(login|setup|reset)/.test(path) && request.method === 'POST';
    if (!admit(getDb(), request.headers.get('x-forwarded-for') ?? 'unknown', isAuth)) {
      return Response.json({ error: { message: 'Too many requests', type: 'rate_limit_error' } }, { status: 429, headers: { 'Retry-After': isAuth ? '900' : '60' } });
    }
    const response = await handleAsNodeRequest(PORT, request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
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
    pruneRequestAnalytics({ force: true });
    getDb().prepare('DELETE FROM cloudflare_admission WHERE expires_ms < ?').run(Date.now());
    getDb().prepare('DELETE FROM sessions WHERE expires_at_ms < ?').run(Date.now());
  }
}
