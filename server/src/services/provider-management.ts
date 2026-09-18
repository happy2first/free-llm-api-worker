import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Platform } from '@freellmapi/shared/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getAllProviders, getProvider, register, unregisterManagedProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import type { ProviderFetchOptions } from '../providers/base.js';
import { assessProviderUrl } from '../lib/url-guard.js';

const SETTING = 'managed_provider_registry_v1';
const definition = z.object({
  platform: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  protocol: z.literal('openai-compatible'),
  baseUrl: z.string().url().max(2048),
  signupUrl: z.string().url().max(2048).optional(),
}).strict();
type Definition = z.infer<typeof definition>;
type Stored = Definition & { source: 'ai'; updatedAt: number };
export class ProviderManagementError extends Error {
  constructor(public status: number, message: string, public existing?: unknown) { super(message); }
}
const managed = new Set<string>();
class ManagedProvider extends OpenAICompatProvider {
  protected override async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number, options?: ProviderFetchOptions): Promise<Response> {
    const check = await assessProviderUrl(url, { blockPrivate: true });
    if (!check.allowed) throw new Error(`Provider URL blocked: ${check.reason}`);
    // Cloudflare workerd only implements "follow" and "manual". Dynamic
    // providers must never follow redirects because the redirected target has
    // not passed the URL guard above. Expose the 3xx and reject it here so the
    // same transport policy covers key validation, model catalog discovery,
    // non-streaming chat and streaming chat.
    const response = await super.fetchWithTimeout(url, { ...init, redirect: 'manual' }, timeoutMs, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? 'an unspecified location';
      throw new Error(
        `Provider URL blocked: upstream redirected (${response.status}) to ${location}; ` +
        'redirects are not followed for managed providers, point baseUrl directly at the API',
      );
    }
    return response;
  }
}
function stored(): Stored[] { return JSON.parse(getSetting(SETTING) ?? '[]'); }
function revision(row: Stored) { return createHash('sha256').update(JSON.stringify(row)).digest('hex'); }
function view(row: Stored) { return { ...row, revision: revision(row), readOnly: false, capabilities: ['chat'] }; }
function install(row: Stored) {
  register(new ManagedProvider({ platform: row.platform as Platform, name: row.name, baseUrl: row.baseUrl }));
  managed.add(row.platform);
}
// Called once after DB initialization, before routes/health/catalog timers use the registry.
export function loadManagedProviders() {
  for (const platform of managed) unregisterManagedProvider(platform as Platform);
  managed.clear();
  for (const row of stored()) {
    if (getProvider(row.platform as Platform)) continue; // built-ins always win
    const { source: _source, updatedAt: _time, ...fields } = row;
    definition.parse(fields);
    install(row);
  }
}
export function listManagedProviders() {
  const custom = new Map(stored().filter(row => managed.has(row.platform)).map(row => [row.platform, view(row)]));
  return getAllProviders().map(p => custom.get(p.platform) ?? { platform: p.platform, name: p.name, source: 'builtin', readOnly: true });
}
export function readManagedProvider(platform: string) { return listManagedProviders().find(p => p.platform === platform) ?? null; }
export async function registerManagedProvider(input: Record<string, unknown>) {
  const { conflict, expectedRevision, ...fields } = input;
  const parsed = definition.safeParse(fields);
  if (!parsed.success) throw new ProviderManagementError(400, parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '));
  const data = parsed.data;
  for (const raw of [data.baseUrl, data.signupUrl].filter(Boolean) as string[]) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ProviderManagementError(400, 'URLs must use HTTPS without credentials, query or fragment');
  }
  data.baseUrl = data.baseUrl.replace(/\/+$/, '');
  const check = await assessProviderUrl(data.baseUrl, { blockPrivate: true });
  if (!check.allowed) throw new ProviderManagementError(400, `Provider URL blocked: ${check.reason}`);
  // Re-read after asynchronous validation so concurrent MCP writes cannot lose updates.
  const rows = stored(), old = rows.find(r => r.platform === data.platform);
  const existing = readManagedProvider(data.platform);
  if (existing) {
    if (conflict === 'skip') return { skipped: true, provider: existing };
    if (!old || !managed.has(data.platform)) throw new ProviderManagementError(409, 'Built-in providers cannot be replaced', existing);
    if (conflict !== 'replace' || expectedRevision !== revision(old)) throw new ProviderManagementError(409, 'Read existing provider; explicitly choose replace with expectedRevision, or skip', existing);
    if (old.baseUrl !== data.baseUrl && getDb().prepare('SELECT 1 FROM api_keys WHERE platform = ? LIMIT 1').get(data.platform)) throw new ProviderManagementError(409, 'Cannot change endpoint while credentials exist. Register a new platform instead.', existing);
  }
  if (!old && rows.length >= 100) throw new ProviderManagementError(400, 'Managed provider limit reached (100)');
  const row: Stored = { ...data, source: 'ai', updatedAt: Date.now() };
  setSetting(SETTING, JSON.stringify([...rows.filter(r => r.platform !== data.platform), row]));
  install(row);
  return { provider: view(row), created: !old };
}
