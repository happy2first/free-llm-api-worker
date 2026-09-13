import type { Db } from '../../server/src/db/types.js';

export function initAdmission(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cloudflare_admission (
    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_ms INTEGER NOT NULL
  )`);
}

// Persist auth throttles as well as ordinary request admission. Evicting an
// object or redeploying must not reset a password guesser's budget.
export function admit(db: Db, ip: string, auth: boolean, now = Date.now()): boolean {
  const windowMs = auth ? 15 * 60_000 : 60_000;
  const limit = auth ? 20 : 240;
  const bucket = `${auth ? 'auth' : 'api'}:${ip}:${Math.floor(now / windowMs)}`;
  const row = db.prepare(`INSERT INTO cloudflare_admission (bucket, count, expires_ms)
    VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1
    RETURNING count`).get(bucket, (Math.floor(now / windowMs) + 1) * windowMs) as { count: number };
  return row.count <= limit;
}
