import { getDb, getSetting, setSetting } from '../../server/src/db/index.js';
const MIB = 1024 * 1024;
const SETTING = 'cloudflare_storage_limit_mib';
export class StoragePolicy {
  private limitMiB: number;
  private lastCheck = 0;
  private lastCleanup: { at: number; logs: number; conversations: number; remainingOverLimit: boolean } | null = null;
  constructor(private size: () => number) {
    const stored = Number(getSetting(SETTING));
    this.limitMiB = Number.isInteger(stored) && stored >= 64 && stored <= 10240 ? stored : 768;
  }
  configure(value: unknown) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 64 || value > 10240) throw new Error('存储上限须为 64–10240 MiB 的整数');
    this.limitMiB = value;
    setSetting(SETTING, String(value));
    this.maintain(true);
    return this.snapshot();
  }
  private usage() {
    // Use the supported Workers API, not unsupported SQLite PRAGMAs.
    return { usedBytes: this.size() };
  }

  snapshot() {
    const usage = this.usage();
    return { ...usage, limitMiB: this.limitMiB, limitBytes: this.limitMiB * MIB,
      overLimit: usage.usedBytes >= this.limitMiB * MIB, lastCleanup: this.lastCleanup,
      checkIntervalSeconds: 300, scope: 'Gateway SQLite only; not account-wide quota',
      policy: 'Oldest logs and conversations first; conversations active in the last hour are protected. Core state is never removed. This is a cleanup target, not a hard write limit.' };
  }
  maintain(force = false) {
    if (!force && Date.now() - this.lastCheck < 300_000) return;
    this.lastCheck = Date.now();
    const limit = this.limitMiB * MIB;
    if (this.usage().usedBytes < limit) return;
    const db = getDb(), target = limit * 0.9, cutoff = Date.now() - 3600_000;
    let logs = 0, conversations = 0;
    // At most 1000 indexed deletions per pass. Protect recent chats, credentials,
    // models, quota/routing state, and audit history. No VACUUM or full-table scans.
    for (let batch = 0; batch < 10 && this.usage().usedBytes >= target; batch++) {
      const oldLogs = db.prepare('SELECT id, created_at_ms AS at FROM server_logs ORDER BY created_at_ms, id LIMIT 100').all() as { id: number; at: number }[];
      const oldChats = db.prepare('SELECT id, updated_at_ms AS at FROM playground_conversations WHERE updated_at_ms < ? ORDER BY updated_at_ms, id LIMIT 100').all(cutoff) as { id: number; at: number }[];
      const oldest = [...oldLogs.map(r => ({ ...r, table: 'server_logs' })), ...oldChats.map(r => ({ ...r, table: 'playground_conversations' }))].sort((a,b) => a.at - b.at || a.id - b.id).slice(0,100);
      if (!oldest.length) break;
      db.transaction(() => {
        for (const r of oldest) {
          if (this.usage().usedBytes < target) break;
          const deleted = db.prepare(`DELETE FROM ${r.table} WHERE id = ?`).run(r.id).changes;
          if (r.table === 'server_logs') logs += deleted; else conversations += deleted;
        }
      })();
    }
    this.lastCleanup = { at: Date.now(), logs, conversations, remainingOverLimit: this.usage().usedBytes >= limit };
    console.info('[cloudflare-storage-cleanup]', JSON.stringify(this.lastCleanup));
  }
}
