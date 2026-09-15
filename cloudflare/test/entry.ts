import { DurableObject } from 'cloudflare:workers';
import { validateToolArguments } from '../../server/src/lib/tool-validate.js';
import { durableSqlite, bindSql } from '../src/sqlite.js';
export { default } from '../src/worker.js';
import { Gateway as ProductionGateway } from '../src/worker.js';

let canceledAiStreams = 0;
// Only built into the test bundle. Never exported by the deployed Worker.
class MockAI {
  failed = false;
  async run(_model: string, inputs: any, options?: { signal?: AbortSignal }) {
    if (inputs.messages.some((m: any) => m.content === 'trigger fallback') && !this.failed) { this.failed = true; throw Object.assign(new Error('Temporary native outage'), { status: 503 }); }
    if (!inputs.stream) return { response: 'native reply', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    let canceled = false;
    return new ReadableStream({ async start(controller) {
      options?.signal?.addEventListener('abort', () => {
        if (!canceled) { canceled = true; canceledAiStreams++; controller.error(options.signal?.reason); }
      }, { once: true });
      const bytes = new TextEncoder().encode('data: {"response":"native stream"}\n\ndata: [DONE]\n\n');
      const boundary = new TextDecoder().decode(bytes).indexOf('data: [DONE]');
      controller.enqueue(bytes.slice(0, boundary));
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!canceled) { controller.enqueue(bytes.slice(boundary)); controller.close(); }
    }, cancel() { canceled = true; canceledAiStreams++; } });
  }
}
export class SqlProbe extends DurableObject {
  fetch() {
    const db = durableSqlite(this.ctx.storage);
    db.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, value TEXT)');
    db.exec('DELETE FROM test');
    db.prepare('INSERT INTO test VALUES (@id, @value)').run({ id: 1, value: 'first' });
    try { db.transaction(() => { db.prepare('INSERT INTO test VALUES (?, ?)').run(2, 'rolled back'); throw new Error('rollback'); })(); } catch {}
    db.transaction(() => {
      db.prepare('INSERT INTO test VALUES (?, ?)').run(3, 'outer');
      try { db.transaction(() => { db.prepare('INSERT INTO test VALUES (?, ?)').run(4, 'inner rollback'); throw new Error('inner'); })(); } catch {}
    })();
    return Response.json({ validTool: validateToolArguments('test', '{\"count\":2}', { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }), invalidTool: validateToolArguments('test', '{\"count\":\"wrong\"}', { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }), rows: db.prepare('SELECT * FROM test ORDER BY id').all(), bound: bindSql("SELECT '@literal', @value -- @comment", [{ value: 7 }]) });
  }
}

let gatewayGeneration = 0;
export class Gateway extends ProductionGateway {
  private generation = ++gatewayGeneration;
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, { ...env, AI: new MockAI() });
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === '/__test/cancel-response') {
      const before = canceledAiStreams;
      const response = await super.fetch(new Request('https://test/v1/chat/completions', { method: 'POST', headers: request.headers, body: await request.text() }));
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ canceled: canceledAiStreams > before });
    }
    if (new URL(request.url).pathname === '/__test/generation') return Response.json({ generation: this.generation });
    if (new URL(request.url).pathname === '/__test/abort') this.ctx.abort('Test gateway reconstruction');
    if (new URL(request.url).pathname === '/__test/maintenance') {
      await this.alarm();
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), usage: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM rate_limit_usage').one().n });
    }
    return super.fetch(request);
  }
}
