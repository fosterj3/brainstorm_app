import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

// Initial values only. Each is a facilitator setting stored per session.
export const DEFAULT_VOTES_PER_PERSON = 3;
export const DEFAULT_IDEAS_PER_PERSON = 3;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // The single-session schema (phases 1-3) had no sessions table. It only ever held development data,
  // so it is replaced rather than migrated.
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get() &&
    !(db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).some((c) => c.name === "session_id");
  if (legacy) db.exec("DROP TABLE IF EXISTS votes; DROP TABLE IF EXISTS participants; DROP TABLE IF EXISTS ideas; DROP TABLE IF EXISTS settings;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      admin_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      bg TEXT NOT NULL DEFAULT '#f5f3ed',
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      code TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      author_token TEXT,
      restored_stars INTEGER NOT NULL DEFAULT 0,
      restored_voters TEXT
    );
    CREATE TABLE IF NOT EXISTS participants (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0,
      UNIQUE (session_id, name_key)
    );
    CREATE TABLE IF NOT EXISTS votes (
      token TEXT NOT NULL REFERENCES participants(token) ON DELETE CASCADE,
      idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      PRIMARY KEY (token, idea_id)
    );
    CREATE INDEX IF NOT EXISTS ideas_session ON ideas(session_id);
    CREATE INDEX IF NOT EXISTS columns_session ON columns(session_id);
    CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);
  `);
  // Restored results (from an uploaded CSV) sit beside live votes. Add the columns to databases made before they existed.
  const icols = db.prepare("PRAGMA table_info(ideas)").all() as { name: string }[];
  if (!icols.some((c) => c.name === "restored_stars")) {
    db.exec("ALTER TABLE ideas ADD COLUMN restored_stars INTEGER NOT NULL DEFAULT 0; ALTER TABLE ideas ADD COLUMN restored_voters TEXT;");
  }
  return db;
}
