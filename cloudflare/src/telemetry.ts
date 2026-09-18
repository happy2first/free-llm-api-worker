import type { RuntimePolicy } from '../../server/src/lib/runtime-policy.js';
export class ResourceMetrics {
  readonly startedAt = Date.now();
  private sql = new Map<string, { calls: number; read: number; written: number }>();
  private events: unknown[] = [];
  private emitted = 0;
  private failed = 0;
  constructor(private analytics?: { writeDataPoint(event: { indexes: string[]; blobs: string[]; doubles: number[] }): void }) {}
  recordSql = (sql: string, read: number, written: number) => {
    const op = sql.trim().split(/\s/)[0].toUpperCase();
    const table = sql.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_][a-z_0-9]*)/i)?.[1] ?? 'other';
    const key = `${op} ${table}`;
    const m = this.sql.get(key) ?? { calls: 0, read: 0, written: 0 };
    m.calls++; m.read += read; m.written += written;
    if (this.sql.size < 256 || this.sql.has(key)) this.sql.set(key, m);
  };
  emit: NonNullable<RuntimePolicy['emit']> = event => {
    this.events.push({ ...event, at: Date.now() });
    if (this.events.length > 100) this.events.shift();
    try {
      this.analytics?.writeDataPoint({ indexes: [event.platform], blobs: [event.type, event.platform, event.model, event.status, event.requestType ?? ''], doubles: [event.input ?? 0, event.output ?? 0, event.latency ?? 0, event.fallback ?? 0] });
      if (this.analytics) this.emitted++;
    } catch { this.failed++; }
  };
  snapshot() {
    return { startedAt: this.startedAt, analyticsEnabled: !!this.analytics, emitted: this.emitted, failed: this.failed, sql: [...this.sql].map(([source, counts]) => ({ source, ...counts })), recent: this.events, note: 'Memory counters reset on reconstruction; SQLite diagnostics only, not billing. Success analytics live in Analytics Engine; legacy SQLite analytics contain historical data and exceptions.' };
  }
}
