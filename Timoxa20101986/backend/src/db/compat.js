// Pure-JS SQLite wrapper (sql.js / WASM) — no native compilation needed
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import initSqlJs from 'sql.js';

class Stmt {
  constructor(dbWrapper, sql) {
    this._w = dbWrapper;
    this._sql = sql;
    this._mutating = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql.trim());
  }

  _bind(args) {
    if (!args || args.length === 0) return [];
    if (args.length === 1) {
      const first = args[0];
      if (Array.isArray(first)) return first.map(v => v ?? null);
      if (first !== null && typeof first === 'object') return first;
      return [first ?? null];
    }
    return args.map(v => v ?? null);
  }

  _normalize(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  }

  run(...args) {
    const bound = this._bind(args);
    this._w._db.run(this._sql, bound);
    const changes = this._w._db.getRowsModified();
    const lastInsertRowid = this._w._lastRowid();
    if (this._mutating && !this._w._inTransaction) this._w._persist();
    return { changes, lastInsertRowid };
  }

  get(...args) {
    const bound = this._bind(args);
    const stmt = this._w._db.prepare(this._sql);
    if (bound.length) stmt.bind(bound);
    const result = stmt.step() ? this._normalize(stmt.getAsObject()) : undefined;
    stmt.free();
    return result;
  }

  all(...args) {
    const bound = this._bind(args);
    const rows = [];
    const stmt = this._w._db.prepare(this._sql);
    if (bound.length) stmt.bind(bound);
    while (stmt.step()) rows.push(this._normalize(stmt.getAsObject()));
    stmt.free();
    return rows;
  }
}

class DB {
  constructor(SQL, filePath) {
    this._filePath = filePath;
    this._inTransaction = false;
    mkdirSync(dirname(filePath), { recursive: true });
    const buf = existsSync(filePath) ? readFileSync(filePath) : null;
    this._db = new SQL.Database(buf);
  }

  pragma(setting) {
    this._db.run(`PRAGMA ${setting}`);
  }

  exec(sql) {
    this._db.run(sql);
    this._persist();
  }

  prepare(sql) {
    return new Stmt(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this._db.run('BEGIN');
      this._inTransaction = true;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._inTransaction = false;
        this._persist();
        return result;
      } catch (e) {
        this._inTransaction = false;
        try { this._db.run('ROLLBACK'); } catch {}
        throw e;
      }
    };
  }

  _persist() {
    writeFileSync(this._filePath, Buffer.from(this._db.export()));
  }

  _lastRowid() {
    const stmt = this._db.prepare('SELECT last_insert_rowid() as r');
    stmt.step();
    const { r } = stmt.getAsObject();
    stmt.free();
    return Number(r);
  }
}

export async function createDB(filePath) {
  const SQL = await initSqlJs();
  return new DB(SQL, filePath);
}
