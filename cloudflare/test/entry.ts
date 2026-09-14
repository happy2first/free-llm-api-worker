import { DurableObject } from 'cloudflare:workers';
import { validateToolArguments } from '../../server/src/lib/tool-validate.js';
import { durableSqlite, bindSql } from '../src/sqlite.js';
export { default } from '../src/worker.js';
import { Gateway as ProductionGateway } from '../src/worker.js';

// Only built into the test bundle. Never exported by the deployed Worker.
class MockAI {
  failed = false;
  async run(_model: string, inputs: any) {
    if (inputs.messages.some((m: any) => m.content === 'trigger fallback') && !this.failed) { this.failed = true; throw Object.assign(new Error('Temporary native outage'), { status: 503 }); }
    if (!inputs.stream) return { response: 'native reply', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    return new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode('data: {"response":"native stream"}\n\ndata: [DONE]\n\n');
      controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); controller.close();
    } });
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
    if (new URL(request.url).pathname === '/__test/generation') return Response.json({ generation: this.generation });
    if (new URL(request.url).pathname === '/__test/abort') this.ctx.abort('Test gateway reconstruction');
    if (new URL(request.url).pathname === '/__test/maintenance') {
      await this.alarm();
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), usage: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM rate_limit_usage').one().n });
    }
    return super.fetch(request);
  }
}
