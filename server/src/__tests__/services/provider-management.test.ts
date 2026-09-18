import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { getProvider, hasProvider } from '../../providers/index.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { loadManagedProviders, registerManagedProvider, readManagedProvider } from '../../services/provider-management.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
vi.mock('../../lib/url-guard.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/url-guard.js')>(), assessProviderUrl: vi.fn().mockResolvedValue({ allowed: true }), assertProviderUrlAllowed: vi.fn() }));
vi.mock('../../lib/proxy.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/proxy.js')>(), proxyFetch: vi.fn((url: string, init: RequestInit) => fetch(url, init)) }));
const def = { platform: 'test-managed', name: 'Managed test', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };
const managedSiliconflowTransport = { platform: 'test-managed-sf', name: 'Managed SiliconFlow transport test', protocol: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1' };
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
it('uses manual redirects and rejects 3xx for every managed-provider transport path', async () => {
  await registerManagedProvider(managedSiliconflowTransport);
  const provider = getProvider(managedSiliconflowTransport.platform as Platform) as OpenAICompatProvider;
  const fetch = vi.fn().mockResolvedValue(new Response(null, {
    status: 302,
    headers: { location: 'https://redirect.example/internal' },
  }));
  vi.stubGlobal('fetch', fetch);

  await expect(provider.validateKey('sf-test-key')).rejects.toThrow(/upstream redirected \(302\)/);
  await expect(provider.fetchModelCatalog('sf-test-key')).rejects.toThrow(/upstream redirected \(302\)/);
  await expect(provider.chatCompletion('sf-test-key', [{ role: 'user', content: 'ping' }], 'Qwen/Qwen2.5-7B-Instruct')).rejects.toThrow(/upstream redirected \(302\)/);
  await expect((async () => {
    for await (const _chunk of provider.streamChatCompletion('sf-test-key', [{ role: 'user', content: 'ping' }], 'Qwen/Qwen2.5-7B-Instruct')) {
      // The redirect is rejected before any stream body can be consumed.
    }
  })()).rejects.toThrow(/upstream redirected \(302\)/);

  expect(assessProviderUrl).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const call of fetch.mock.calls) expect(call[1].redirect).toBe('manual');
});

it('exercises siliconflow-cn valid key, invalid key, model catalog and real chat/stream adapter paths', async () => {
  const provider = getProvider('siliconflow-cn') as OpenAICompatProvider;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    expect(href.startsWith('https://api.siliconflow.cn/v1/')).toBe(true);
    const authorization = new Headers(init?.headers).get('authorization');

    if (authorization === 'Bearer sf-bad-key') {
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'Qwen/Qwen2.5-7B-Instruct', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.stream) {
        const sse = [
          'data: {"id":"chatcmpl-sf-stream","object":"chat.completion.chunk","created":1,"model":"Qwen/Qwen2.5-7B-Instruct","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl-sf-stream","object":"chat.completion.chunk","created":1,"model":"Qwen/Qwen2.5-7B-Instruct","choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-sf',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);

  expect(readManagedProvider('siliconflow-cn')).toMatchObject({ platform: 'siliconflow-cn', name: 'SiliconFlow China', readOnly: true });
  expect(await provider.validateKey('sf-valid-key')).toBe(true);
  await expect(provider.validateKey('sf-bad-key')).resolves.toMatchObject({ valid: false, error: expect.stringContaining('HTTP 401') });

  const catalog = await provider.fetchModelCatalog('sf-valid-key');
  expect((await catalog.json()).data[0].id).toBe('Qwen/Qwen2.5-7B-Instruct');

  const completion = await provider.chatCompletion(
    'sf-valid-key',
    [{ role: 'user', content: 'Reply only pong' }],
    'Qwen/Qwen2.5-7B-Instruct',
    { max_tokens: 4 },
  );
  expect(completion.choices[0].message.content).toBe('pong');

  const chunks = [];
  for await (const chunk of provider.streamChatCompletion(
    'sf-valid-key',
    [{ role: 'user', content: 'Reply only pong' }],
    'Qwen/Qwen2.5-7B-Instruct',
    { max_tokens: 4 },
  )) chunks.push(chunk);
  expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? '').join('')).toBe('pong');

  expect(fetch.mock.calls.some(call => String(call[0]).endsWith('/models'))).toBe(true);
  expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/chat/completions')).length).toBe(2);
});
