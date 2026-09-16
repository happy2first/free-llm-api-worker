import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const issue = (audience = 'dashboard', expiration = '1h') => new SignJWT({ email: 'test@example.com' })
  .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
  .setIssuer('https://test.cloudflareaccess.com').setAudience(audience)
  .setSubject('admin').setIssuedAt().setExpirationTime(expiration).sign(privateKey);
const accessToken = await issue();
const { privateKey: attackerKey } = await generateKeyPair('RS256');
const forgedSignature = await new SignJWT({ email: 'test@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://test.cloudflareaccess.com').setAudience('dashboard').setSubject('admin').setIssuedAt().setExpirationTime('1h').sign(attackerKey);
const options = (persist) => ({
  name: 'gateway', modules: true, scriptPath: 'cloudflare/dist/test.js',
  compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { GATEWAY: { className: 'Gateway', useSQLite: true }, SQL_PROBE: { className: 'SqlProbe', useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: { ENCRYPTION_KEY: '12'.repeat(32), TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'dashboard', NODE_ENV: 'production', CATALOG_SYNC_DISABLED: '1' },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'test.cloudflareaccess.com' && url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    if (url.hostname === 'api.groq.com') {
      if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      return Response.json({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'llama-3.3-70b-versatile', choices: [{ index: 0, message: { role: 'assistant', content: 'groq reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
    }
    if (url.hostname === 'api.freellmapi.co') return Response.json({ version: '2099.01.01', generatedAt: '2099-01-01', tier: 'monthly', models: [], quirks: [] }, { headers: { 'x-catalog-signature': 'AA==' } });
    throw new Error(`Unexpected outbound host in test: ${url.hostname}`);
  },
  serviceBindings: { ASSETS: () => new Response('dashboard asset'), AI: () => new Response('{}') },
});

test('real workerd: migrations, setup security, API-key lifecycle and restart persistence', { timeout: 120_000 }, async () => {
  const persist = await mkdtemp(join(tmpdir(), 'freeapi-cf-'));
  let mf = new Miniflare({ ...convertV4MiniflareOptions(options(persist)), resourcePersistencePath: persist, isolatedResourcePersistencePath: persist });
  const request = (path, body, token, method) => mf.dispatchFetch(`https://gateway.test${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(!path.startsWith('/v1/') ? { 'Cf-Access-Jwt-Assertion': accessToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const ping = await request('/api/ping');
    assert.equal(ping.status, 200, await ping.clone().text());
    assert.equal((await request('/api/keys')).status, 200);
    assert.equal((await request('/v1/models')).status, 401);
    for (const path of ['/', '/api/auth/status', '/api/auth/setup', '/api/keys', '/v1beta/models', '/v1%2f../api/keys']) {
      assert.equal((await mf.dispatchFetch(`https://gateway.test${path}`)).status, 403, path);
    }
    for (const invalid of ['forged', forgedSignature, await issue('other-app'), await issue('dashboard', Math.floor(Date.now()/1000)-60)]) {
      assert.equal((await mf.dispatchFetch('https://gateway.test/api/auth/status', { headers: { 'Cf-Access-Jwt-Assertion': invalid } })).status, 403);
    }
    assert.equal((await mf.dispatchFetch('https://gateway.test/api/client-profiles', {
      method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': accessToken, Origin: 'https://other.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CSRF' }),
    })).status, 403);
    const status = await (await request('/api/auth/status')).json();
    assert.equal(status.needsSetup, false);
    assert.equal(status.authenticated, true);
    assert.equal(status.email, 'test@example.com');
    assert.equal((await request('/api/auth/setup', { email: 'test@example.com', password: 'unused' })).status, 409);
    assert.equal((await request('/api/auth/login', { email: 'test@example.com', password: 'unused' })).status, 409);
    const token = undefined; // No local admin account or session exists.
    const keys = await request('/api/keys', null, token);
    assert.equal(keys.status, 200, await keys.clone().text());
    const created = await request('/api/client-profiles', { name: 'Test application' }, token);
    assert.equal(created.status, 201, await created.clone().text());
    const profile = await created.json();
    assert.ok(profile.key);
    assert.equal((await mf.dispatchFetch('https://gateway.test/api/keys', { headers: { authorization: `Bearer ${profile.key}` } })).status, 403);
    assert.equal((await request('/api/keys/export')).status, 200);
    assert.equal((await request('/v1/models', null, profile.key)).status, 200);
    const models = await (await request('/api/models', null, token)).json();
    const cfModel = models.find(m => m.platform === 'cloudflare' && m.enabled);
    assert.ok(cfModel, 'bundled catalog includes a Cloudflare model');
    const chat = await request('/v1/chat/completions', { model: cfModel.modelId, messages: [{ role: 'user', content: 'Hello' }] }, profile.key);
    assert.equal(chat.status, 200, await chat.clone().text());
    assert.equal((await chat.json()).choices[0].message.content, 'native reply');
    const streaming = await request('/v1/chat/completions', { model: cfModel.modelId, messages: [{ role: 'user', content: 'Stream please' }], stream: true }, profile.key);
    assert.equal(streaming.status, 200);
    await Promise.all(Array.from({ length: 5 }, () => request('/api/conversations')));
    const sse = await streaming.text();
    assert.match(sse, /native stream/);
    assert.match(sse, /\[DONE\]/);
    const cancellationNs = await mf.getDurableObjectNamespace('GATEWAY');
    const canceledResponse = await cancellationNs.get(cancellationNs.idFromName('primary')).fetch('https://test/__test/cancel-response', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.key}` },
      body: JSON.stringify({ model: cfModel.modelId, messages: [{ role: 'user', content: 'Cancel this stream' }], stream: true }),
    });
    assert.equal((await canceledResponse.json()).canceled, true, 'response cancellation reaches the AI stream');
    const responseApi = await request('/v1/responses', { model: cfModel.modelId, input: 'Respond please' }, profile.key);
    assert.equal(responseApi.status, 200, await responseApi.clone().text());
    assert.match(await responseApi.text(), /native reply/);
    const groqKey = await request('/api/keys', { platform: 'groq', key: 'gsk_test_key_for_runtime_only', label: 'Groq test' }, token);
    assert.equal(groqKey.status, 201, await groqKey.clone().text());
    const groqModel = models.find(m => m.platform === 'groq' && m.enabled);
    assert.ok(groqModel);
    const groq = await request('/v1/chat/completions', { model: groqModel.modelId, messages: [{ role: 'user', content: 'Groq please' }] }, profile.key);
    assert.equal(groq.status, 200, await groq.clone().text());
    assert.equal((await groq.json()).choices[0].message.content, 'groq reply');
    const fallbackModel = groqModel;
    assert.ok(fallbackModel);
    await request(`/api/models/${fallbackModel.id}`, { enabled: true }, token, 'PATCH');
    const chain = await request('/api/fallback', models.map(m => ({ modelDbId: m.id, priority: m.id === cfModel.id ? 0 : 1, enabled: [cfModel.id, fallbackModel.id].includes(m.id) })), token, 'PUT');
    assert.equal(chain.status, 200, await chain.clone().text());
    await request('/api/fallback/routing', { strategy: 'priority' }, token, 'PUT');
    const recovered = await request('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'trigger fallback' }] }, profile.key);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.choices[0].message.content, 'groq reply');
    assert.equal(recoveredBody._routed_via.model, fallbackModel.modelId);
    const probe = await mf.getDurableObjectNamespace('SQL_PROBE');
    const probeResult = await (await probe.get(probe.idFromName('test')).fetch('https://sql.test')).json();
    assert.ok(probeResult.sizeAfterDelete < probeResult.sizeBeforeDelete, 'native databaseSize excludes freed pages');
    assert.equal(probeResult.admitted, 240);
    assert.equal(probeResult.resetAdmission, true);
    assert.deepEqual(probeResult.points, [{ indexes: ['cloudflare'], blobs: ['request','cloudflare','test','success',''], doubles: [2,3,5,0] }]);
    assert.equal(probeResult.validTool.ok, true);
    assert.equal(probeResult.invalidTool.ok, false);
    assert.deepEqual(probeResult.rows.map(row => row.id), [1, 3]);
    assert.deepEqual(probeResult.bound, { sql: "SELECT '@literal', ? -- @comment", values: [7] });
    // Reconstruct just the object, keeping its isolate (and HTTP registry) alive.
    const ns = await mf.getDurableObjectNamespace('GATEWAY');
    const stub = () => ns.get(ns.idFromName('primary'));
    const generation = async () => (await (await stub().fetch('https://test/__test/generation')).json()).generation;
    let previous = await generation();
    for (let i = 0; i < 2; i++) {
      await assert.rejects(stub().fetch('https://test/__test/abort'));
      const response = await request('/v1/models', null, profile.key);
      assert.equal(response.status, 200, await response.clone().text());
      const current = await generation();
      assert.ok(current > previous, 'object reconstructed in the same isolate');
      previous = current;
      assert.equal((await request('/v1/models')).status, 401);
      assert.equal((await request('/api/auth/status')).status, 200);
      assert.equal((await request('/api/client-profiles')).status, 200);
    }
    await mf.dispose();
    mf = new Miniflare({ ...convertV4MiniflareOptions(options(persist)), resourcePersistencePath: persist, isolatedResourcePersistencePath: persist });
    assert.equal((await request('/v1/models', null, profile.key)).status, 200);
    assert.equal((await request('/api/client-profiles', null, token)).status, 200);
    const gateway = await mf.getDurableObjectNamespace('GATEWAY');
    const maintenance = await (await gateway.get(gateway.idFromName('primary')).fetch('https://test/__test/maintenance')).json();
    assert.ok(maintenance.alarm > Date.now());
    assert.ok(maintenance.usage > 0, 'quota usage survived restart');
    const disabled = await request(`/api/client-profiles/${profile.id}`, { enabled: false }, token, 'PATCH');
    assert.equal(disabled.status, 200, await disabled.clone().text());
    assert.equal((await request('/v1/models', null, profile.key)).status, 401);
    assert.equal((await request('/api/update')).status, 501);
    assert.equal(await (await request('/')).text(), 'dashboard asset');
  } finally {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});

test('catalog ownership, explicit conflicts, MCP authorization, restoration and SQL budgets', { timeout: 120_000 }, async () => {
  const persist = await mkdtemp(join(tmpdir(), 'freeapi-catalog-'));
  const mf = new Miniflare({ ...convertV4MiniflareOptions(options(persist)), resourcePersistencePath: persist, isolatedResourcePersistencePath: persist });
  const request = (path, body) => mf.dispatchFetch(`https://gateway.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'Cf-Access-Jwt-Assertion': accessToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const live = await mf.dispatchFetch('https://gateway.test/livez');
    assert.equal(live.status, 200, 'liveness needs no Access or DO');
    const catalog = await (await request('/api/catalog')).json();
    assert.ok(catalog.records.length > 25);
    const resources = await (await request('/api/runtime/resources')).json();
    assert.equal(resources.storage.limitMiB, 768);
    assert.ok(resources.storage.usedBytes > 0);
    const storageResponse = await mf.dispatchFetch('https://gateway.test/api/runtime/storage', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ limitMiB: 512 }) });
    assert.equal(storageResponse.status, 200, await storageResponse.clone().text());
    assert.equal((await storageResponse.json()).limitMiB, 512);
    assert.equal((await mf.dispatchFetch('https://gateway.test/api/catalog/mcp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer downstream-key' } })).status, 403);
    const ns = await mf.getDurableObjectNamespace('GATEWAY');
    const stub = ns.get(ns.idFromName('primary'));
    const count = async () => (await stub.fetch('https://test/__test/sql-counts')).json();
    const profile = await (await request('/api/client-profiles', { name: 'SQL budget test' })).json();
    const model = catalog.records.find(r => r.kind === 'chat' && r.platform === 'cloudflare' && r.values.enabled);
    const before = await count();
    const metricsBefore = await (await request('/api/runtime/resources')).json();
    const response = await mf.dispatchFetch('https://gateway.test/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.key}` }, body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'Budget' }] }) });
    assert.equal(response.status, 200); await response.text();
    const after = await count();
    for (const table of ['requests','request_hourly','request_attempts','server_logs']) assert.equal(after[table], before[table], `success makes no ${table} inserts`);
    assert.equal(after.cloudflare_routing_events, before.cloudflare_routing_events + 1);
    const metricsAfter = await (await request('/api/runtime/resources')).json();
    const writes = (m, table) => m.sql.filter(r => r.source.endsWith(` ${table}`)).reduce((n,r) => n + r.written, 0);
    for (const table of ['settings','requests','request_hourly','request_attempts','server_logs','cloudflare_admission']) assert.equal(writes(metricsAfter, table), writes(metricsBefore, table), `success makes no ${table} writes`);
    assert.ok(metricsAfter.recent.some(e => e.type === 'request' && e.status === 'success'));

    const totals = async () => {
      const m = await (await request('/api/runtime/resources')).json();
      return m.sql.reduce((v,r) => ({ written: v.written + r.written, read: v.read + r.read }), { written: 0, read: 0 });
    };
    const baselineStart = await totals();
    await stub.fetch('https://test/__test/log-batch', { method: 'POST', body: JSON.stringify({ cloudflare: false }) });
    const baselineEnd = await totals();
    await stub.fetch('https://test/__test/log-batch', { method: 'POST', body: JSON.stringify({ cloudflare: true }) });
    const optimizedEnd = await totals();
    const baselineWrites = baselineEnd.written - baselineStart.written;
    const optimizedWrites = optimizedEnd.written - baselineEnd.written;
    assert.ok(optimizedWrites < baselineWrites / 2, 'request logging writes reduced by more than half');
    console.log('SQL logging benchmark (10 successes)', JSON.stringify({ baselineWrites, optimizedWrites, baselineReads: baselineEnd.read - baselineStart.read, optimizedReads: optimizedEnd.read - baselineEnd.read }));

    const fixtures = [
      { kind: 'chat', platform: 'cloudflare', modelId: 'test-chat', values: { display_name: 'Chat', context_window: 4096 } },
      { kind: 'embedding', platform: 'google', modelId: 'test-embed', values: { display_name: 'Embed', family: 'test', dimensions: 128 } },
      { kind: 'media', platform: 'cloudflare', modelId: 'test-image', values: { display_name: 'Image', modality: 'image' } },
      { kind: 'quirk', platform: '', modelId: 'test-quirk', values: { title: 'Quirk', body: 'Manual', severity: 'warning', targets: [{ platform: 'cloudflare', model_glob: '*' }] } },
    ];
    const created = [];
    for (const f of fixtures) {
      const res = await request('/api/catalog/records/create', f); assert.equal(res.status, 200, await res.clone().text());
      const r = (await res.json()).record; assert.equal(r.source, 'user'); assert.ok(r.updatedAt > 0); created.push(r);
      const conflict = await request('/api/catalog/records/update', { ...r, values: { ...r.values, ...(r.kind === 'quirk' ? { title: 'Changed' } : { display_name: 'Changed' }) } });
      assert.equal(conflict.status, 409); assert.equal((await conflict.json()).existing.revision, r.revision);
      const skip = await request('/api/catalog/records/update', { ...r, conflict: 'skip' }); assert.equal((await skip.json()).skipped, true);
    }
    const mcp = async (name, args) => (await (await request('/api/catalog/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()).result;
    for (const r of created) {
      const conflict = await mcp('catalog_update', r); assert.equal(conflict.isError, true);
      const result = await mcp('catalog_update', { ...r, conflict: 'replace', expectedRevision: r.revision, origin: 'provider_docs', extensions: { requiresCreditCard: false, evidenceLinks: ['https://example.com/docs'] } });
      assert.equal(JSON.parse(result.content[0].text).record.source, 'ai');
    }
    const chat = { platform: 'cloudflare', modelId: 'test-chat', displayName: 'OFFICIAL', intelligenceRank: 1, speedRank: 1, sizeLabel: '', limits: { rpm: 5, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: '', contextWindow: 100, enabled: true, supportsVision: false, supportsTools: true };
    const doc = { version: '2026.09.15', generatedAt: '2026-09-15T00:00:00Z', tier: 'monthly', models: [chat, { ...chat, modelId: 'test-image', modality: 'image' }], embeddings: [{ platform: 'google', modelId: 'test-embed', displayName: 'OFFICIAL', family: 'test', dimensions: 128, maxInputTokens: 100, priority: 1, enabled: true, quotaLabel: '' }], quirks: [{ slug: 'test-quirk', title: 'OFFICIAL', body: 'signed', severity: 'info', targets: [] }] };
    const sync = async d => { const res = await stub.fetch('https://test/__test/catalog-sync', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(d) }); assert.equal(res.status, 200, await res.clone().text()); };
    await sync(doc);
    // The same protection applies to manual ownership, not only AI ownership.
    for (const r of created) {
      const current = JSON.parse((await mcp('catalog_read', r)).content[0].text);
      const manual = await request('/api/catalog/records/update', { ...current, conflict: 'replace', expectedRevision: current.revision });
      assert.equal(manual.status, 200);
    }
    await sync(doc);
    for (const r of created) {
      const current = JSON.parse((await mcp('catalog_read', r)).content[0].text);
      assert.equal(current.source, 'user');
      assert.notEqual(current.values.display_name ?? current.values.title, 'OFFICIAL');
      await mcp('catalog_update', { ...current, conflict: 'replace', expectedRevision: current.revision });
    }
    for (const r of created) {
      const current = JSON.parse((await mcp('catalog_read', r)).content[0].text);
      assert.equal(current.source, 'ai'); assert.notEqual(current.values.display_name ?? current.values.title, 'OFFICIAL');
    }
    await sync({ ...doc, models: [], embeddings: [{ ...doc.embeddings[0], modelId: 'another-embed' }], quirks: [] });
    for (const r of created) assert.equal(JSON.parse((await mcp('catalog_read', r)).content[0].text).source, 'ai', 'monthly prune preserves AI ownership');
    await sync(doc);
    for (const r of created) {
      const current = JSON.parse((await mcp('catalog_read', r)).content[0].text);
      const restored = await request('/api/catalog/records/restore', { ...r, conflict: 'replace', expectedRevision: current.revision });
      assert.equal(restored.status, 200, await restored.clone().text());
      const official = (await restored.json()).record;
      assert.equal(official.source, 'freellm'); assert.equal(official.values.display_name ?? official.values.title, 'OFFICIAL');
      // Stale approvals cannot overwrite a changed row.
      assert.equal((await request('/api/catalog/records/update', { ...r, conflict: 'replace', expectedRevision: current.revision })).status, 409);
      const deleted = await mcp('catalog_delete', { ...r, conflict: 'replace', expectedRevision: official.revision }); assert.notEqual(deleted.isError, true);
    }
    await sync(doc);
    for (const r of created) assert.equal(JSON.parse((await mcp('catalog_read', r)).content[0].text), null, 'deleted local records cannot resurrect');
    const badSync = await (await request('/api/catalog/sync', {})).json();
    assert.equal(badSync.ok, false);
    assert.match(badSync.detail, /signature/i);
    await request('/api/premium/sync', {});
    const history = (await (await request('/api/catalog')).json()).status.history;
    assert.equal(history[0].action, 'sync');
    assert.equal(JSON.parse(history[0].detail_json).trigger, 'premium');
    assert.equal(JSON.parse(history[1].detail_json).trigger, 'catalog-page');
    assert.deepEqual(badSync.diff, { added: 0, updated: 0, removed: 0 });
    // Restore a tombstone explicitly as well.
    const restored = await request('/api/catalog/records/restore', { ...created[0], conflict: 'replace' }); assert.equal(restored.status, 200, await restored.clone().text());
  } finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
});
