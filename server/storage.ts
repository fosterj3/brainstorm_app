import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * The only thing the rest of the server knows about where data lives. All reading and writing goes through this
 * small interface, and `DB` (in db.ts) is just another name for it.
 *
 * It is deliberately narrow, and it is the same shape the code already used: prepare a statement, run it, wrap
 * several in a transaction. To move to another backend, write one more adapter below and register it.
 * Two things a backend must offer:
 *
 * 1. It must be synchronous. Ority makes a decision, such as "is this vote allowed?", and records it in one step
 *    inside a transaction. Waiting on a network round trip in the middle would break that. SQLite-compatible
 *    engines that run inside the server process fit (the built-in `node:sqlite`, or libSQL with a local file).
 *    A database that lives across the network and only answers asynchronously (such as hosted Turso queried
 *    over HTTP) would need every call site made async first. That is a bigger change, and the load test is the
 *    way to check it afterwards.
 * 2. It must understand SQLite's SQL, because the schema and queries are written in it.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  /** The first matching row, or undefined. */
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export interface Storage {
  /** Which adapter this is, for example "sqlite". */
  readonly kind: string;
  /** Where the data is: a file path, or ":memory:". */
  readonly location: string;
  prepare(sql: string): Statement;
  /** Run one or more statements that return nothing, such as creating tables. */
  exec(sql: string): void;
  /**
   * Wrap a function in a transaction. Call the result to run it. Everything inside is saved together or not at all,
   * and a transaction started inside another one joins it.
   */
  transaction<T>(fn: () => T): () => T;
  /** Write a complete copy of the database to a file. It is safe to do while the app is running. */
  backup(file: string): Promise<void>;
  close(): void;
}

export interface StorageConfig {
  kind: string;
  /** For file-based adapters. */
  file: string;
}

function sqlite(config: StorageConfig): Storage {
  const { file } = config;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets reads continue while a write is saved. Foreign keys make deleting a poll delete everything in it.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return {
    kind: "sqlite",
    location: file,
    prepare: (sql) => db.prepare(sql) as unknown as Statement,
    exec: (sql) => void db.exec(sql),
    transaction: (fn) => db.transaction(fn) as unknown as () => ReturnType<typeof fn>,
    backup: async (target) => {
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      await db.backup(target);
    },
    close: () => void db.close(),
  };
}

/** The adapters this build knows about. Add one here to support another backend. */
const ADAPTERS: Record<string, (config: StorageConfig) => Storage> = { sqlite };

export const STORAGE_KINDS = Object.keys(ADAPTERS);

export function openStorage(config: StorageConfig): Storage {
  const adapter = ADAPTERS[config.kind];
  if (!adapter) throw new Error(`Unknown storage "${config.kind}". Choose one of: ${STORAGE_KINDS.join(", ")}.`);
  return adapter(config);
}
