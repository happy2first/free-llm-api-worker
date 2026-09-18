import type { Db } from '../db/types.js';
export type CatalogKind = 'chat' | 'embedding' | 'media' | 'quirk';
export const catalogTables = { chat: 'models', embedding: 'embedding_models', media: 'media_models', quirk: 'quirks' } as const;
export function identity(kind: string, platform: string, model: string): string { return JSON.stringify([kind, platform, model]); }
// One snapshot per sync, not a SQL lookup per catalog row. Deleted local entries
// remain protected too, including embeddings/quirks which have no legacy tombstone.
export function protectedCatalogEntries(db: Db): Set<string> {
  const result = new Set<string>();
  for (const [kind, table] of Object.entries(catalogTables)) {
    const columns = kind === 'quirk' ? "'' AS platform, slug AS model_id" : 'platform, model_id';
    const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE source IN ('user', 'ai')`).all() as { platform: string; model_id: string }[];
    for (const r of rows) result.add(identity(kind, r.platform, r.model_id));
  }
  const deleted = db.prepare('SELECT kind, platform, model_id FROM catalog_annotations WHERE deleted_source IS NOT NULL').all() as { kind: string; platform: string; model_id: string }[];
  for (const r of deleted) result.add(identity(r.kind, r.platform, r.model_id));
  return result;
}
