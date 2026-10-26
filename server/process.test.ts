import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { listIdeas } from "./ideas";
import { startSnapshots } from "./persist";
import { createSession } from "./sessions";
import { BUCKET, fakeBucket, KEY_ID, SECRET } from "./testbucket";
import { join, setVote } from "./votes";

/**
 * These start the real server program (not just its parts) the way a host does, with its own settings, and check
 * what it does on a blank disk: restore from the bucket, refuse to start if the bucket cannot be reached, and
 * run as before when backup is off.
 */
const free = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await sleep(150);
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ority-proc-")); dirs.push(d); return d; };

function start(env: Record<string, string>) {
  const port = free();
  return port.then((p) => {
    const out: string[] = [];
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
      env: { ...process.env, PORT: String(p), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout!.on("data", (d) => out.push(String(d)));
    child.stderr!.on("data", (d) => out.push(String(d)));
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    return { port: p, out, child, exited, base: `http://127.0.0.1:${p}` };
  });
}
async function waitHealthy(base: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r.json() as Promise<any>;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error("the server did not start");
}

describe("the real server on a blank disk", () => {
  it("restores the saved polls at startup and keeps saving afterwards", async () => {
    const bucket = await fakeBucket();
    cleanups.push(bucket.close);
    // A previous life of the server saved a poll to the bucket.
    const oldDir = tmp();
    const old = openDb(path.join(oldDir, "old.db"));
    const { id, adminKey } = createSession(old, { title: "From the last life", mode: "poll", options: ["A", "B"], deadline: Date.now() + 86_400_000 });
    setVote(old, id, join(old, id, "Ann").token, listIdeas(old, id)[0].id, true);
    const seed = startSnapshots({ db: old, s3: bucket.s3, prefix: "ority/", intervalMs: 3_600_000 });
    await seed.flush();
    seed.stop();
    old.close();

    const dataDir = tmp(); // blank, like a freshly started host
    const s = await start({
      DB_PATH: path.join(dataDir, "ority.db"),
      BACKUP_S3_ENDPOINT: bucket.endpoint, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: SECRET, BACKUP_S3_REGION: "us-test-001",
      BACKUP_INTERVAL_SECONDS: "5",
    });
    const health = await waitHealthy(s.base);
    expect(health.backup.enabled).toBe(true);
    const board = await (await fetch(`${s.base}/api/s/${id}/board`)).json() as any;
    expect(board.board.title).toBe("From the last life");
    expect(board.ideas.map((i: any) => i.title)).toEqual(["A", "B"]);
    const closed = await fetch(`${s.base}/api/s/${id}/admin/action`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": adminKey }, body: JSON.stringify({ action: "close" }) });
    expect(closed.status).toBe(200);
    expect(s.out.join("")).toContain("Restored the database from the saved copy");
    // It reports a saved copy soon after start.
    for (let i = 0; i < 40 && !(await (await fetch(`${s.base}/api/health`)).json() as any).backup.lastSavedAt; i++) await sleep(150);
    expect(((await (await fetch(`${s.base}/api/health`)).json()) as any).backup.ok).toBe(true);
  }, 60_000);

  it("refuses to start, and leaves the saved copy untouched, when the bucket refuses its key", async () => {
    const bucket = await fakeBucket();
    cleanups.push(bucket.close);
    await bucket.s3.put("ority/latest.db.gz", gzipSync(Buffer.from("precious")));
    const dataDir = tmp();
    const s = await start({
      DB_PATH: path.join(dataDir, "ority.db"),
      BACKUP_S3_ENDPOINT: bucket.endpoint, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: "wrong-secret", BACKUP_S3_REGION: "us-test-001",
    });
    const code = await Promise.race([s.exited, sleep(40_000).then(() => "hung")]);
    expect(code).toBe(1);
    expect(s.out.join("")).toMatch(/not starting \(the saved copy is untouched\)/);
    expect(fs.existsSync(path.join(dataDir, "ority.db"))).toBe(false); // no empty database was made to overwrite it later
    expect((await bucket.s3.get("ority/latest.db.gz"))!.length).toBeGreaterThan(0);
    expect(bucket.objects.get("ority/latest.db.gz")).toEqual(gzipSync(Buffer.from("precious")));
  }, 90_000);

  it("refuses a half-finished setup with a message that says what is missing", async () => {
    const s = await start({ DB_PATH: path.join(tmp(), "ority.db"), BACKUP_S3_BUCKET: "only-this" });
    const code = await Promise.race([s.exited, sleep(30_000).then(() => "hung")]);
    expect(code).not.toBe("hung");
    expect(code).not.toBe(0);
    expect(s.out.join("")).toMatch(/Backup is half set up\. Also set: BACKUP_S3_ENDPOINT/);
  }, 60_000);

  it("runs as before when backup is off, and says so", async () => {
    const s = await start({ DB_PATH: path.join(tmp(), "ority.db") });
    const health = await waitHealthy(s.base);
    expect(health.backup).toEqual({ enabled: false });
    expect(s.out.join("")).toContain("Backup is off");
  }, 60_000);
});
