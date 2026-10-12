import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

// Initial values only. Each is a facilitator setting stored in the settings table.
export const DEFAULT_VOTES_PER_PERSON = 3;
export const DEFAULT_IDEAS_PER_PERSON = 3;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS participants (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS votes (
      token TEXT NOT NULL REFERENCES participants(token) ON DELETE CASCADE,
      idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      PRIMARY KEY (token, idea_id)
    );
  `);
  // Migration: remember who suggested an idea (never sent to participants).
  const cols = db.prepare("PRAGMA table_info(ideas)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "author_token")) db.exec("ALTER TABLE ideas ADD COLUMN author_token TEXT");
  const pcols = db.prepare("PRAGMA table_info(participants)").all() as { name: string }[];
  if (!pcols.some((c) => c.name === "submitted")) db.exec("ALTER TABLE participants ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0");
  return db;
}
