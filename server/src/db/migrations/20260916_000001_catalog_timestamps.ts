import type { Db } from '../types.js';
export function up(db: Db): void {
  // Unknown historical update times remain NULL; do not invent a migration-time update.
  const columns = db.prepare('PRAGMA table_info(catalog_annotations)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'updated_at_ms')) db.exec('ALTER TABLE catalog_annotations ADD COLUMN updated_at_ms INTEGER');
}
export function down(db: Db): void {
  db.exec('ALTER TABLE catalog_annotations DROP COLUMN updated_at_ms');
}
