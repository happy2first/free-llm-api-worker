import { beforeAll, it, expect } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { StoragePolicy } from '../../../../cloudflare/src/storage-policy.js';
beforeAll(() => { process.env.ENCRYPTION_KEY = '00'.repeat(32); initDb(':memory:'); });
it('defaults to 768 MiB, validates changes and persists policy', () => {
  const policy = new StoragePolicy(() => 1024 * 1024);
  expect(policy.snapshot().limitMiB).toBe(768);
  for (const v of [0, -1, 63, 10241, 100.5, '768', null]) expect(() => policy.configure(v)).toThrow();
  policy.configure(512);
  expect(new StoragePolicy(() => 1024).snapshot().limitMiB).toBe(512);
});
it('cleans oldest eligible rows under pressure and preserves active conversations and core state', () => {
  const db = getDb(), now = Date.now();
  const chat = db.prepare('INSERT INTO playground_conversations(title, messages_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)');
  chat.run('old', '[]', now - 7200000, now - 7200000);
  chat.run('active', '[]', now, now);
  db.prepare('INSERT INTO server_logs(id, level, message, created_at_ms) VALUES (?, ?, ?, ?)').run(1, 'warn', 'old log', now - 10800000);
  const models = db.prepare('SELECT COUNT(*) AS n FROM models').get();
  // Synthetic non-reclaimable core size deliberately stays over the threshold.
  // Cleanup must stop when eligible rows are gone, never erase active/core data.
  const policy = new StoragePolicy(() => 100 * 1024 * 1024);
  policy.configure(64);
  expect(db.prepare('SELECT title FROM playground_conversations').all()).toEqual([{ title: 'active' }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM server_logs').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM models').get()).toEqual(models);
  expect(policy.snapshot().lastCleanup).toMatchObject({ logs: 1, conversations: 1, remainingOverLimit: true });
  policy.maintain(true);
  expect(db.prepare('SELECT title FROM playground_conversations').all()).toEqual([{ title: 'active' }]);
});
it('stops deleting at the target and orders logs and chats together by age', () => {
  const db = getDb(), now = Date.now();
  db.prepare('INSERT INTO server_logs(id, level, message, created_at_ms) VALUES (?, ?, ?, ?)').run(2, 'warn', 'oldest', now - 14400000);
  const insert = db.prepare('INSERT INTO playground_conversations(title, messages_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)');
  insert.run('older', '[]', now - 10800000, now - 10800000);
  insert.run('keep', '[]', now - 7200000, now - 7200000);
  const size = () => {
    const row = db.prepare('SELECT (SELECT COUNT(*) FROM server_logs) + (SELECT COUNT(*) FROM playground_conversations WHERE updated_at_ms < ?) AS n').get(now - 3600000) as { n: number };
    return (50 + row.n * 6) * 1024 * 1024;
  };
  const policy = new StoragePolicy(size);
  policy.configure(64);
  expect(policy.snapshot().lastCleanup).toMatchObject({ logs: 1, conversations: 1, remainingOverLimit: false });
  expect(db.prepare('SELECT title FROM playground_conversations ORDER BY id').all()).toEqual([{ title: 'active' }, { title: 'keep' }]);
});
