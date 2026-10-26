import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DB } from "./db";
import type { S3 } from "./s3";
import { openStorage } from "./storage";

/**
 * Keeps polls alive on hosting that erases its disk when the service sleeps, restarts or deploys.
 *
 * - While running, a compressed copy of the whole database is saved to a private S3-compatible bucket shortly after
 *   anything changes (at most once per interval), and again when the service is told to shut down.
 * - On startup, if there is no database file yet, the latest copy is downloaded and put in place.
 *
 * The honest limit: if the service is killed without warning, changes from the last interval (a minute by default)
 * can be lost. Nothing else is: the copy survives sleeping, restarts, deploys and weeks of nobody visiting.
 */
const LATEST = "latest.db.gz";

export interface Logger {
  (message: string): void;
}

export interface BackupStatus {
  enabled: boolean;
  /** When the last copy was saved, as an ISO time, or null. */
  lastSavedAt: string | null;
  /** Whether the most recent attempt worked. */
  ok: boolean;
}

/** The key under which the current copy is kept. */
export const latestKey = (prefix: string) => `${prefix}${LATEST}`;

/**
 * If there is no database file on this disk, fetch the latest saved copy. Never replaces a database that exists.
 * Returns what happened, so the server can say so in its log.
 */
export async function restoreIfNeeded(opts: { file: string; s3: S3; prefix: string; log?: Logger }): Promise<"kept" | "restored" | "none" | "unusable"> {
  const log = opts.log ?? (() => {});
  if (opts.file === ":memory:") return "kept";
  if (fs.existsSync(opts.file) && fs.statSync(opts.file).size > 0) return "kept";
  const packed = await opts.s3.get(latestKey(opts.prefix));
  if (!packed) {
    log("No saved copy found. Starting with an empty database.");
    return "none";
  }
  const temp = `${opts.file}.restoring`;
  try {
    fs.mkdirSync(path.dirname(path.resolve(opts.file)), { recursive: true });
    fs.writeFileSync(temp, gunzipSync(packed));
    // Make sure the file really is a working database before it is used.
    const check = openStorage({ kind: "sqlite", file: temp });
    let answer: { quick_check?: string } | undefined;
    try {
      answer = check.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    } finally {
      check.close();
    }
    if (answer?.quick_check !== "ok") throw new Error("the saved copy failed its integrity check");
    for (const extra of ["-wal", "-shm"]) fs.rmSync(`${opts.file}${extra}`, { force: true });
    fs.renameSync(temp, opts.file);
    log(`Restored the database from the saved copy (${(packed.length / 1024).toFixed(0)} KB).`);
    return "restored";
  } catch (e) {
    try {
      fs.rmSync(temp, { force: true });
      for (const extra of ["-wal", "-shm"]) fs.rmSync(`${temp}${extra}`, { force: true });
    } catch {
      /* a leftover temporary file does no harm: it is overwritten next time */
    }
    // Starting empty is better than failing to start at all, but the first new copy would overwrite this one, so
    // set it aside under its own name first. It can be inspected or restored by hand.
    const aside = `${opts.prefix}unusable/${new Date().toISOString().replace(/[:.]/g, "-")}.db.gz`;
    await opts.s3.put(aside, packed, "application/gzip").catch(() => {});
    log(`The saved copy could not be used (${e instanceof Error ? e.message : e}). Starting with an empty database. The copy was kept as ${aside}.`);
    return "unusable";
  }
}

export interface Snapshots {
  /** Save a copy now if anything has changed since the last one. */
  flush(): Promise<void>;
  /** Stop the timer. */
  stop(): void;
  status(): BackupStatus;
}

/** Save copies of `db` to the bucket whenever it has changed. */
export function startSnapshots(opts: {
  db: DB;
  s3: S3;
  prefix: string;
  intervalMs: number;
  /** How many daily copies to keep besides the latest one. */
  keepDaily?: number;
  log?: Logger;
  now?: () => Date;
}): Snapshots {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const keepDaily = opts.keepDaily ?? 14;
  let savedWrites = -1; // nothing saved yet, so the first check always saves one
  let lastSavedAt: string | null = null;
  let ok = true;
  let running: Promise<void> | null = null;
  let lastDaily = "";

  async function save() {
    const target = opts.db.writes; // read before copying, so a change made during the copy is picked up next time
    const temp = path.join(path.dirname(path.resolve(opts.db.location)), `.snapshot-${process.pid}.db`);
    try {
      await opts.db.backup(temp);
      const packed = gzipSync(fs.readFileSync(temp));
      await opts.s3.put(latestKey(opts.prefix), packed, "application/gzip");
      const day = now().toISOString().slice(0, 10);
      if (day !== lastDaily) {
        // One extra copy a day, so a bad change can be undone by hand. Older ones are pruned.
        await opts.s3.put(`${opts.prefix}daily/${day}.db.gz`, packed, "application/gzip");
        lastDaily = day;
        const old = (await opts.s3.list(`${opts.prefix}daily/`)).sort();
        for (const key of old.slice(0, Math.max(0, old.length - keepDaily))) await opts.s3.delete(key);
      }
      savedWrites = target;
      lastSavedAt = now().toISOString();
      if (!ok) log("Saving copies works again.");
      ok = true;
    } catch (e) {
      // Never crash the server over a backup problem. It is tried again at the next check.
      if (ok) log(`Could not save a copy of the database: ${e instanceof Error ? e.message : e}. Will keep trying.`);
      ok = false;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  const flush = async () => {
    if (running) await running; // let a copy already in progress finish, then check again
    if (opts.db.writes === savedWrites) return;
    running = save().finally(() => { running = null; });
    await running;
  };

  const timer = setInterval(() => void flush(), opts.intervalMs);
  timer.unref();
  void flush(); // the first copy, right after startup
  return {
    flush,
    stop: () => clearInterval(timer),
    status: () => ({ enabled: true, lastSavedAt, ok }),
  };
}
