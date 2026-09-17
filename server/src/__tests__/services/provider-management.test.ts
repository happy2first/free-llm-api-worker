import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { getProvider, hasProvider } from '../../providers/index.js';
import { loadManagedProviders, registerManagedProvider, readManagedProvider } from '../../services/provider-management.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
vi.mock('../../lib/url-guard.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/url-guard.js')>(), assessProviderUrl: vi.fn().mockResolvedValue({ allowed: true }), assertProviderUrlAllowed: vi.fn() }));
vi.mock('../../lib/proxy.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/proxy.js')>(), proxyFetch: vi.fn((url: string, init: RequestInit) => fetch(url, init)) }));
const def = { platform: 'test-managed', name: 'Managed test', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };
beforeAll(() => { process.env.ENCRYPTION_KEY = '00'.repeat(32); initDb(':memory:'); });
beforeEach(() => { getDb().prepare("DELETE FROM api_keys WHERE platform = ?").run(def.platform); setSetting('managed_provider_registry_v1', '[]'); loadManagedProviders(); vi.mocked(assessProviderUrl).mockResolvedValue({ allowed: true }); });
afterEach(() => vi.unstubAllGlobals());
it('registers separately from catalog and restores the adapter after reload', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM models').get();
  const result = await registerManagedProvider(def);
  expect(result.created).toBe(true);
  expect(hasProvider(def.platform as Platform)).toBe(true);
  expect(getProvider(def.platform as Platform)?.name).toBe(def.name);
  loadManagedProviders();
  expect(readManagedProvider(def.platform)?.name).toBe(def.name);
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM models').get()).toEqual(before);
});
it('requires explicit revision-based replace and never replaces built-in platforms', async () => {
  await registerManagedProvider(def);
  await expect(registerManagedProvider(def)).rejects.toMatchObject({ status: 409 });
  expect((await registerManagedProvider({ ...def, conflict: 'skip' })).skipped).toBe(true);
  const existing = readManagedProvider(def.platform) as { revision: string };
  await registerManagedProvider({ ...def, name: 'Renamed', conflict: 'replace', expectedRevision: existing.revision });
  expect(getProvider(def.platform as Platform)?.name).toBe('Renamed');
  await expect(registerManagedProvider({ ...def, platform: 'groq', conflict: 'replace' })).rejects.toMatchObject({ status: 409 });
});
it('blocks endpoint changes with credentials and rejects unsupported or unsafe configurations', async () => {
  await registerManagedProvider(def);
  const existing = readManagedProvider(def.platform) as { revision: string };
  getDb().prepare("INSERT INTO api_keys(platform,encrypted_key,iv,auth_tag) VALUES (?, 'secret','','')").run(def.platform);
  await expect(registerManagedProvider({ ...def, baseUrl: 'https://other.example.com/v1', conflict: 'replace', expectedRevision: existing.revision })).rejects.toMatchObject({ status: 409 });
  for (const change of [{ protocol: 'gemini' }, { baseUrl: 'http://example.com' }, { baseUrl: 'https://user:secret@example.com/v1' }, { apiKey: 'secret' }]) await expect(registerManagedProvider({ ...def, ...change })).rejects.toMatchObject({ status: 400 });
  vi.mocked(assessProviderUrl).mockResolvedValue({ allowed: false, reason: 'private endpoint' });
  await expect(registerManagedProvider({ ...def, baseUrl: 'https://127.0.0.1' })).rejects.toMatchObject({ status: 400 });
});
it('reuses the adapter and guards every outgoing call with redirects disabled', async () => {
  await registerManagedProvider(def);
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await getProvider(def.platform as Platform)!.validateKey('test');
  expect(assessProviderUrl).toHaveBeenLastCalledWith('https://api.example.com/v1/models', { blockPrivate: true });
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
});
