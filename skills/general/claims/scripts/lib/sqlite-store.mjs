// Local SQLite claims store (prototype backend).
//
// A store implements the interface below. The CLI talks only to this interface,
// so a shared hosted backend can replace this file later without changing the
// `claim` command surface.
//
//   acquire({ key, holder, ttlMs, note, now }) -> { status: "acquired" | "renewed" | "held", claim }
//   renew({ key, holder, ttlMs, note, now })   -> { status: "renewed" | "acquired" | "held", claim }
//   release({ key, holder, now })              -> { status: "released" | "free" | "held", claim }
//   releaseAll({ holder, now })                -> { status: "released", keys }
//   steal({ key, holder, ttlMs, note, reason, now }) -> { status: "stolen", claim, previous }
//   show({ key, now })                         -> { status: "held" | "free", claim }
//   list({ now, stale })                       -> { claims }
//   close()
//
// Times are milliseconds since the epoch. A claim whose expires_at <= now is free.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  key         TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',
  ttl_ms      INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  key         TEXT NOT NULL,
  action      TEXT NOT NULL,
  holder      TEXT NOT NULL,
  previous_holder TEXT,
  note        TEXT,
  reason      TEXT
);
`;

export async function openSqliteStore(file) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 10_000 });
  db.exec("PRAGMA busy_timeout = 10000");
  // Switching to WAL needs a brief exclusive lock; retry if another process is creating the DB.
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
      break;
    } catch (error) {
      if (attempt >= 50 || !/locked|busy/i.test(String(error?.message))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 30));
    }
  }
  return new SqliteStore(db);
}

class SqliteStore {
  constructor(db) {
    this.db = db;
    this.host = os.hostname();
    this.getStmt = db.prepare("SELECT * FROM claims WHERE key = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO claims (key, holder, note, host, ttl_ms, acquired_at, renewed_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, note = excluded.note, host = excluded.host,
        ttl_ms = excluded.ttl_ms, acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at,
        expires_at = excluded.expires_at`);
    this.renewStmt = db.prepare(
      "UPDATE claims SET note = ?, ttl_ms = ?, renewed_at = ?, expires_at = ? WHERE key = ?",
    );
    this.deleteStmt = db.prepare("DELETE FROM claims WHERE key = ?");
    this.historyStmt = db.prepare(
      "INSERT INTO history (at, key, action, holder, previous_holder, note, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  close() {
    this.db.close();
  }

  // Run fn inside BEGIN IMMEDIATE so the read and the write are one compare-and-set.
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  get(key) {
    return this.getStmt.get(key) ?? null;
  }

  log(now, key, action, holder, { previous = null, note = null, reason = null } = {}) {
    this.historyStmt.run(now, key, action, holder, previous, note, reason);
  }

  take(key, holder, ttlMs, note, now) {
    this.upsertStmt.run(key, holder, note ?? "", this.host, ttlMs, now, now, now + ttlMs);
    return this.get(key);
  }

  extend(row, ttlMs, note, now) {
    this.renewStmt.run(note ?? row.note, ttlMs, now, now + ttlMs, row.key);
    return this.get(row.key);
  }

  acquire({ key, holder, ttlMs, note, now }) {
    return this.tx(() => {
      const row = this.get(key);
      if (row && row.expires_at > now && row.holder !== holder) return { status: "held", claim: row };
      if (row && row.holder === holder) {
        this.log(now, key, "renew", holder, { note });
        return { status: "renewed", claim: this.extend(row, ttlMs, note, now) };
      }
      const previous = row ? row.holder : null;
      this.log(now, key, previous ? "takeover-expired" : "acquire", holder, { previous, note });
      return { status: "acquired", claim: this.take(key, holder, ttlMs, note, now) };
    });
  }

  renew({ key, holder, ttlMs, note, now }) {
    // Renewing a lapsed claim nobody else took re-acquires it; a live claim held by
    // someone else is never touched.
    return this.acquire({ key, holder, ttlMs, note, now });
  }

  release({ key, holder, now }) {
    return this.tx(() => {
      const row = this.get(key);
      if (!row) return { status: "free", claim: null };
      if (row.holder !== holder) {
        return row.expires_at > now ? { status: "held", claim: row } : { status: "free", claim: null };
      }
      this.deleteStmt.run(key);
      this.log(now, key, "release", holder);
      return { status: "released", claim: row };
    });
  }

  releaseAll({ holder, now }) {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT key FROM claims WHERE holder = ? ORDER BY key").all(holder);
      for (const { key } of rows) {
        this.deleteStmt.run(key);
        this.log(now, key, "release", holder, { reason: "release-all" });
      }
      return { status: "released", keys: rows.map((row) => row.key) };
    });
  }

  steal({ key, holder, ttlMs, note, reason, now }) {
    return this.tx(() => {
      const row = this.get(key);
      const previous = row && row.expires_at > now ? row : null;
      this.log(now, key, "steal", holder, { previous: previous?.holder ?? null, note, reason });
      return { status: "stolen", claim: this.take(key, holder, ttlMs, note, now), previous };
    });
  }

  show({ key, now }) {
    const row = this.get(key);
    if (!row || row.expires_at <= now) return { status: "free", claim: null };
    return { status: "held", claim: row };
  }

  list({ now, stale = false }) {
    const rows = this.db.prepare("SELECT * FROM claims ORDER BY key").all();
    if (!stale) return { claims: rows.filter((row) => row.expires_at > now) };
    // Stale: expired but never released, or no renewal for more than half the lease.
    return { claims: rows.filter((row) => row.expires_at <= now || now - row.renewed_at > row.ttl_ms / 2) };
  }
}
