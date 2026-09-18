import type { Db } from '../../server/src/db/types.js';

// DO SQLite accepts positional bindings. Tokenize SQL so named parameters in
// quoted strings, identifiers and comments are never accidentally replaced.
export function bindSql(sql: string, params: unknown[]): { sql: string; values: any[] } {
  if (params.length === 1 && Array.isArray(params[0])) params = params[0];
  const named = params.length === 1 && params[0] !== null &&
    typeof params[0] === 'object' && !ArrayBuffer.isView(params[0]) && !(params[0] instanceof ArrayBuffer)
    ? params[0] as Record<string, unknown> : null;
  if (!named) return { sql, values: params };
  const values: unknown[] = [];
  const rewritten = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[@:$][A-Za-z_][A-Za-z_0-9]*/g, token => {
    if (!/^[@:$]/.test(token)) return token;
    const key = token.slice(1);
    if (!Object.hasOwn(named, key)) throw new Error(`Missing SQL parameter: ${key}`);
    values.push(named[key]);
    return '?';
  });
  return { sql: rewritten, values };
}

export function durableSqlite(storage: DurableObjectStorage, measure?: (sql: string, read: number, written: number) => void): Db {
  const query = (sql: string, params: unknown[] = []) => {
    // DO SQLite has no TEMP database. This upstream migration creates and
    // drops its scratch tables inside one atomic transaction, so main-schema
    // tables have the same lifetime and rollback semantics here.
    sql = sql.replace(/^CREATE TEMP TABLE ("_endpoint_identity_[^"]+")/i, 'CREATE TABLE $1');
    const bound = bindSql(sql, params);
    try {
      const cursor = storage.sql.exec(bound.sql, ...bound.values);
      const rows = cursor.toArray();
      measure?.(sql, cursor.rowsRead, cursor.rowsWritten);
      return { toArray: () => rows, one: () => rows[0] };
    }
    catch (error) { console.error('[sqlite] statement failed:', bound.sql.slice(0, 400)); throw error; }
  };
  return {
    prepare(sql) {
      return {
        get: (...params) => query(sql, params).toArray()[0],
        all: (...params) => query(sql, params).toArray(),
        run: (...params) => {
          query(sql, params).toArray();
          const row = query('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').one();
          return { changes: Number(row.changes), lastInsertRowid: Number(row.lastInsertRowid) };
        },
      };
    },
    exec(sql) { query(sql).toArray(); },
    pragma(source) { return query(`PRAGMA ${source}`).toArray(); },
    transaction(fn) {
      return function (this: unknown, ...args: unknown[]) {
        return storage.transactionSync(() => {
          const result = fn.apply(this, args);
          if (result && typeof (result as any).then === 'function') {
            throw new Error('SQLite transaction callbacks must be synchronous');
          }
          return result;
        });
      } as typeof fn;
    },
  };
}
