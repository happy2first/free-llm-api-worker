import type { Db } from '../db/types.js';
import { catalogTables, identity } from './catalog-ownership.js';
// Snapshot only on catalog checks, never on the request hot path.
export function catalogSnapshot(db: Db): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [kind, table] of Object.entries(catalogTables)) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[]) {
      const { created_at_ms, updated_at_ms, ...value } = row;
      if (kind === 'quirk') value.targets = db.prepare('SELECT platform, model_glob FROM quirk_targets WHERE quirk_id = ? ORDER BY platform, model_glob').all(row.id);
      entries.set(identity(kind, kind === 'quirk' ? '' : row.platform, kind === 'quirk' ? row.slug : row.model_id), JSON.stringify(value));
    }
  }
  return entries;
}
export function recordCatalogCheck(db: Db, before: Map<string, string>, result: unknown, trigger: string) {
  const after = catalogSnapshot(db), at = Date.now();
  const diff = { added: 0, updated: 0, removed: 0 };
  db.transaction(() => {
    for (const [key, value] of after) {
      if (before.get(key) === value) continue;
      if (before.has(key)) diff.updated++; else diff.added++;
      const [kind, platform, model] = JSON.parse(key);
      db.prepare(`INSERT INTO catalog_annotations(kind, platform, model_id, updated_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(kind, platform, model_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms`).run(kind, platform, model, at);
    }
    for (const key of before.keys()) if (!after.has(key)) diff.removed++;
    db.prepare('INSERT INTO catalog_history(at_ms, action, detail_json) VALUES (?, ?, ?)').run(at, 'sync', JSON.stringify({ trigger, result, diff }));
    db.prepare('DELETE FROM catalog_history WHERE id NOT IN (SELECT id FROM catalog_history ORDER BY id DESC LIMIT 100)').run();
  })();
  return { diff, checkedAt: at };
}
