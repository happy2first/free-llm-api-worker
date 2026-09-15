import type { Db } from '../types.js';
export function up(db: Db): void {
  for (const table of ['media_models', 'embedding_models', 'quirks']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(c => c.name === 'source')) db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog'`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_annotations (
    kind TEXT NOT NULL, platform TEXT NOT NULL, model_id TEXT NOT NULL,
    origin TEXT, extensions_json TEXT NOT NULL DEFAULT '{}', deleted_source TEXT,
    PRIMARY KEY(kind, platform, model_id)
  ); CREATE TABLE IF NOT EXISTS catalog_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, action TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );`);
  db.exec("UPDATE embedding_models SET source = 'user' WHERE platform = 'custom' OR key_id IS NOT NULL");
  db.exec("UPDATE media_models SET source = 'user' WHERE platform = 'custom' OR key_id IS NOT NULL");
}
export function down(db: Db): void {
  db.exec('DROP TABLE catalog_history; DROP TABLE catalog_annotations');
  for (const table of ['media_models', 'embedding_models', 'quirks']) db.exec(`ALTER TABLE ${table} DROP COLUMN source`);
  // Preserve AI-owned chat entries as user-owned for older binaries.
  db.exec("UPDATE models SET source = 'user' WHERE source = 'ai'");
}
