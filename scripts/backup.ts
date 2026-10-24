/**
 * Make a safe copy of the database while the app keeps running.
 *
 *   npm run backup                       writes backups/ority-<date>-<time>.db
 *   npm run backup -- --out my-copy.db   writes exactly that file
 *
 * It uses the same settings as the server: DB_PATH (and STORAGE) from the environment or .env.
 * To restore, stop the app, replace the database file (and delete its -wal and -shm files), and start it again.
 */
import path from "node:path";
import fs from "node:fs";
import { defaultDbPath, openDb } from "../server/db";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const target = path.resolve(out ?? `backups/ority-${stamp}.db`);

const source = defaultDbPath(process.env.DB_PATH);
if (source !== ":memory:" && !fs.existsSync(source)) {
  console.error(`No database found at ${source}. Nothing to back up.`);
  process.exit(1);
}
const db = openDb(source, process.env.STORAGE ?? "sqlite");
await db.backup(target);
db.close();
console.log(`Backed up ${source} to ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB).`);
