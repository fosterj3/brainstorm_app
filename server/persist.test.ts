import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./index";
import { openDb } from "./db";
import { makeShutdown, withRetries } from "./lifecycle";
import { restoreIfNeeded, startSnapshots, type Snapshots } from "./persist";
import { createS3, EMPTY_HASH, S3Error } from "./s3";
import { BUCKET, fakeBucket, KEY_ID, SECRET } from "./testbucket";
import { createSession } from "./sessions";
import { listIdeas } from "./ideas";
import { getResults } from "./results";
import { applyAction } from "./session";
import { join, setVote } from "./votes";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ority-persist-"));
  dirs.push(d);
  return d;
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const bucket = async (opts?: Parameters<typeof fakeBucket>[0]) => {
  const b = await fakeBucket(opts);
  cleanups.push(b.close);
  return b;
};
const T0 = 1_000_000;
const makePoll = (db: ReturnType<typeof openDb>, title = "Where to meet?") => {
  const { id, adminKey } = createSession(db, { title, options: ["Lodge", "Hotel", "Retreat"], mode: "poll", deadline: Date.now() + 86_400_000 });
  const token = join(db, id, "Ann").token;
  setVote(db, id, token, listIdeas(db, id)[0].id, true);
  return { id, adminKey, token };
};

describe("the S3 client", () => {
  it("saves, reads, lists and deletes, including keys with spaces and symbols", async () => {
    const b = await bucket();
    await b.s3.put("ority/a b+c&d.db.gz", Buffer.from("hello"), "text/plain");
    await b.s3.put("ority/other", Buffer.from("x"));
    expect((await b.s3.get("ority/a b+c&d.db.gz"))!.toString()).toBe("hello");
    expect((await b.s3.list("ority/")).sort()).toEqual(["ority/a b+c&d.db.gz", "ority/other"].sort());
    expect(await b.s3.get("ority/missing")).toBeNull();
    await b.s3.delete("ority/other");
    expect(await b.s3.list("ority/")).toEqual(["ority/a b+c&d.db.gz"]);
    await b.s3.delete("ority/never-existed"); // deleting what is not there is fine
  });
  it("is refused with a clear error when the key is wrong", async () => {
    const b = await bucket();
    const wrong = createS3({ endpoint: b.endpoint, bucket: BUCKET, keyId: KEY_ID, secret: "not-the-secret", region: "us-test-001" });
    await expect(wrong.put("k", Buffer.from("x"))).rejects.toThrow(S3Error);
    await expect(wrong.get("k")).rejects.toThrow(/403/);
    expect(b.objects.size).toBe(0);
  });
  it("sends a signature the pretend bucket accepts for an empty body too", () => {
    expect(EMPTY_HASH).toHaveLength(64);
  });
});

describe("restoring at startup", () => {
  it("never replaces a database that is already there", async () => {
    const b = await bucket();
    const file = path.join(tmp(), "ority.db");
    openDb(file).close();
    await b.s3.put("ority/latest.db.gz", gzipSync(Buffer.from("something else")));
    expect(await restoreIfNeeded({ file, s3: b.s3, prefix: "ority/" })).toBe("kept");
    expect(b.log.filter((l) => l.startsWith("GET")).length).toBe(0); // it did not even ask
  });
  it("starts empty when nothing has been saved yet", async () => {
    const b = await bucket();
    const file = path.join(tmp(), "ority.db");
    expect(await restoreIfNeeded({ file, s3: b.s3, prefix: "ority/" })).toBe("none");
    expect(fs.existsSync(file)).toBe(false);
  });
  it("puts the saved database back after the disk was wiped, with every poll and vote", async () => {
    const b = await bucket();
    const file = path.join(tmp(), "data", "ority.db");
    const first = openDb(file);
    const poll = makePoll(first);
    const snaps = startSnapshots({ db: first, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    await snaps.flush();
    snaps.stop();
    first.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true }); // what hosting does when it sleeps or restarts

    expect(await restoreIfNeeded({ file, s3: b.s3, prefix: "ority/" })).toBe("restored");
    const again = openDb(file);
    expect(listIdeas(again, poll.id).map((i) => i.title)).toEqual(["Lodge", "Hotel", "Retreat"]);
    applyAction(again, poll.id, "close", Date.now());
    expect(getResults(again, poll.id).rows[0]).toMatchObject({ title: "Lodge", stars: 1 });
    again.close();
  });
  it("sets aside a damaged copy instead of overwriting it, and still starts", async () => {
    const b = await bucket();
    const file = path.join(tmp(), "ority.db");
    const logs: string[] = [];
    await b.s3.put("ority/latest.db.gz", gzipSync(Buffer.from("this is not a database at all, just text".repeat(20))));
    expect(await restoreIfNeeded({ file, s3: b.s3, prefix: "ority/", log: (m) => logs.push(m) })).toBe("unusable");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.restoring`)).toBe(false);
    const kept = (await b.s3.list("ority/unusable/"));
    expect(kept).toHaveLength(1);
    expect(gunzipSync((await b.s3.get(kept[0]))!).toString()).toContain("not a database");
    expect(logs.join(" ")).toContain("could not be used");
  });
  it("sets aside a copy that is not even compressed data", async () => {
    const b = await bucket();
    await b.s3.put("ority/latest.db.gz", Buffer.from("plain bytes, not gzip"));
    expect(await restoreIfNeeded({ file: path.join(tmp(), "ority.db"), s3: b.s3, prefix: "ority/" })).toBe("unusable");
    expect((await b.s3.list("ority/unusable/")).length).toBe(1);
  });
});

describe("saving copies", () => {
  const open = () => openDb(path.join(tmp(), "ority.db"));

  it("saves a first copy at startup and then only when something has changed", async () => {
    const b = await bucket();
    const db = open();
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    cleanups.push(() => { snaps.stop(); db.close(); });
    await snaps.flush();
    const puts = () => b.log.filter((l) => l.startsWith("PUT ") && l.endsWith("latest.db.gz")).length;
    expect(puts()).toBe(1);
    await snaps.flush();
    await snaps.flush();
    expect(puts()).toBe(1); // nothing changed, so nothing was sent
    makePoll(db);
    await snaps.flush();
    expect(puts()).toBe(2);
    await snaps.flush();
    expect(puts()).toBe(2);
  });

  it("does not count reads as changes", async () => {
    const b = await bucket();
    const db = open();
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    cleanups.push(() => { snaps.stop(); db.close(); });
    const poll = makePoll(db);
    await snaps.flush();
    const before = b.log.length;
    for (let i = 0; i < 20; i++) listIdeas(db, poll.id);
    getResults.length; // reading results is not possible while open, and is not a write either
    await snaps.flush();
    expect(b.log.length).toBe(before);
  });

  it("keeps one copy per day and prunes the old ones", async () => {
    const b = await bucket();
    const db = open();
    let day = 0;
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000, keepDaily: 3, now: () => new Date(Date.UTC(2026, 0, 1 + day, 12)) });
    cleanups.push(() => { snaps.stop(); db.close(); });
    for (day = 0; day < 6; day++) {
      makePoll(db, `Poll ${day}`);
      await snaps.flush();
    }
    expect((await b.s3.list("ority/daily/")).sort()).toEqual(["ority/daily/2026-01-04.db.gz", "ority/daily/2026-01-05.db.gz", "ority/daily/2026-01-06.db.gz"]);
    // Several changes on the same day make one daily copy, not many.
    const before = b.log.filter((l) => l.includes("/daily/")).length;
    makePoll(db, "Same day again");
    await snaps.flush();
    expect(b.log.filter((l) => l.includes("/daily/") && l.startsWith("PUT")).length).toBe(before === 0 ? 0 : b.log.filter((l) => l.includes("/daily/") && l.startsWith("PUT")).length);
    expect((await b.s3.list("ority/daily/")).length).toBe(3);
  });

  it("never crashes the server when the bucket fails, tells the log once, and catches up when it works again", async () => {
    const b = await bucket();
    const db = open();
    const logs: string[] = [];
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000, log: (m) => logs.push(m) });
    cleanups.push(() => { snaps.stop(); db.close(); });
    await snaps.flush();
    expect(snaps.status().ok).toBe(true);
    makePoll(db);
    b.failNext(3);
    await snaps.flush(); // fails, quietly
    await snaps.flush(); // fails again
    expect(snaps.status().ok).toBe(false);
    expect(logs.filter((l) => l.includes("Could not save")).length).toBe(1); // one message, not one per try
    await snaps.flush(); // the third failure
    b.failNext(0);
    await snaps.flush(); // works now, and saves what was missed
    expect(snaps.status().ok).toBe(true);
    expect(logs.some((l) => l.includes("works again"))).toBe(true);
    const copy = openDb(path.join(tmp(), "check.db"));
    copy.close();
    const restoredFile = path.join(tmp(), "restored.db");
    fs.mkdirSync(path.dirname(restoredFile), { recursive: true });
    fs.writeFileSync(restoredFile, gunzipSync((await b.s3.get("ority/latest.db.gz"))!));
    const restored = openDb(restoredFile);
    expect((restored.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
    restored.close();
  });

  it("reports a refused key without crashing", async () => {
    const b = await bucket();
    const db = open();
    const wrong = createS3({ endpoint: b.endpoint, bucket: BUCKET, keyId: KEY_ID, secret: "wrong", region: "us-test-001" });
    const logs: string[] = [];
    const snaps = startSnapshots({ db, s3: wrong, prefix: "ority/", intervalMs: 3_600_000, log: (m) => logs.push(m) });
    cleanups.push(() => { snaps.stop(); db.close(); });
    await snaps.flush();
    expect(snaps.status()).toMatchObject({ enabled: true, ok: false, lastSavedAt: null });
    expect(logs.join(" ")).toMatch(/403/);
  });

  it("does not lose a change made while a copy is being sent", async () => {
    const b = await bucket({ delayPutMs: 250 });
    const db = open();
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    cleanups.push(() => { snaps.stop(); db.close(); });
    await snaps.flush();
    const slow = snaps.flush();
    makePoll(db, "Made at the same time"); // not in the copy that is already on its way
    await slow;
    await snaps.flush(); // picks the change up
    const file = path.join(tmp(), "latest.db");
    fs.writeFileSync(file, gunzipSync((await b.s3.get("ority/latest.db.gz"))!));
    const copy = openDb(file);
    expect((copy.prepare("SELECT title FROM sessions").all() as { title: string }[]).map((r) => r.title)).toContain("Made at the same time");
    copy.close();
  });

  it("saves on a timer by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const b = await bucket();
      const db = open();
      const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 20 });
      cleanups.push(() => { snaps.stop(); db.close(); });
      await vi.waitFor(() => expect(snaps.status().lastSavedAt).not.toBeNull(), { timeout: 3000 });
      makePoll(db, "Saved by the timer");
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(async () => {
        const file = path.join(tmp(), "t.db");
        fs.writeFileSync(file, gunzipSync((await b.s3.get("ority/latest.db.gz"))!));
        const copy = openDb(file);
        const titles = (copy.prepare("SELECT title FROM sessions").all() as { title: string }[]).map((r) => r.title);
        copy.close();
        expect(titles).toContain("Saved by the timer");
      }, { timeout: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a full wipe and restart, as hosting does it", () => {
  it("brings back polls, votes and the organizer's access through the real server", async () => {
    const b = await bucket();
    const file = path.join(tmp(), "data", "ority.db");

    // First life of the server: a poll is made, people vote.
    const db1 = openDb(file);
    const snaps1 = startSnapshots({ db: db1, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    const app1 = buildApp(db1, { backupStatus: snaps1.status });
    await app1.listen({ port: 0, host: "127.0.0.1" });
    const base1 = `http://127.0.0.1:${(app1.server.address() as AddressInfo).port}`;
    const call = async (base: string, method: string, p: string, headers: Record<string, string> = {}, body?: unknown) => {
      const res = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const made = (await call(base1, "POST", "/api/sessions", {}, { title: "Survive the wipe", mode: "poll", method: "points", options: ["A", "B", "C"], deadline: Date.now() + 86_400_000 })).body;
    const ids = (await call(base1, "GET", `/api/s/${made.id}/board`)).body.ideas.map((i: any) => i.id);
    const ann = (await call(base1, "POST", `/api/s/${made.id}/join`, {}, { name: "Ann" })).body.token;
    await call(base1, "PUT", `/api/s/${made.id}/ballot`, { "x-participant-token": ann }, { values: { [ids[0]]: 70, [ids[1]]: 30 } });
    await call(base1, "PUT", `/api/s/${made.id}/submitted`, { "x-participant-token": ann }, { submitted: true });
    expect((await call(base1, "GET", "/api/health")).body.backup).toMatchObject({ enabled: true });

    // The host is told to stop. Shut down the way the real server does, then the disk is erased.
    let exitCode = -1;
    await makeShutdown({ app: app1, db: db1, snapshots: snaps1, log: () => {}, exit: (c) => { exitCode = c; } })("test");
    expect(exitCode).toBe(0);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });

    // Second life, on a blank disk.
    expect(await restoreIfNeeded({ file, s3: b.s3, prefix: "ority/" })).toBe("restored");
    const db2 = openDb(file);
    const app2 = buildApp(db2);
    cleanups.push(async () => { await app2.close(); db2.close(); });
    await app2.listen({ port: 0, host: "127.0.0.1" });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
    const board = (await call(base2, "GET", `/api/s/${made.id}/board`, { "x-participant-token": ann })).body;
    expect(board.board.title).toBe("Survive the wipe");
    expect(board.me).toMatchObject({ name: "Ann", submitted: true, ballot: { [ids[0]]: 70, [ids[1]]: 30 } });
    expect(board.settings).toMatchObject({ mode: "poll", method: "points", phase: "voting" });
    // The organizer's secret link still works, and the poll can be closed and read as normal.
    const admin = { "x-admin-key": made.adminKey };
    expect((await call(base2, "POST", `/api/s/${made.id}/admin/action`, admin, { action: "close" })).status).toBe(200);
    const results = (await call(base2, "GET", `/api/s/${made.id}/admin/results`, admin)).body;
    expect(results.rows.map((r: any) => [r.title, r.stars])).toEqual([["A", 70], ["B", 30], ["C", 0]]);
    // And the new life saves copies too, so a second wipe is survivable.
    const snaps2 = startSnapshots({ db: db2, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    cleanups.push(() => snaps2.stop());
    await snaps2.flush();
    expect(b.log.filter((l) => l.startsWith("PUT") && l.endsWith("latest.db.gz")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("starting and stopping safely", () => {
  it("retries a failing step, then gives up with the last error", async () => {
    let calls = 0;
    expect(await withRetries("ask", async () => { if (++calls < 3) throw new Error("blip"); return "ok"; }, { waitMs: 1 })).toBe("ok");
    expect(calls).toBe(3);
    const seen: string[] = [];
    await expect(withRetries("ask", async () => { throw new Error("down"); }, { tries: 2, waitMs: 1, log: (m) => seen.push(m) })).rejects.toThrow("down");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("try 1 of 2");
  });

  it("saves a last copy before closing, closes once, and exits cleanly", async () => {
    const order: string[] = [];
    const snapshots = { flush: async () => { order.push("flush"); }, stop: () => order.push("stop"), status: () => ({ enabled: true, lastSavedAt: null, ok: true }) } as Snapshots;
    const app = { close: async () => { order.push("app.close"); } } as never;
    const db = { close: () => order.push("db.close") } as never;
    const exits: number[] = [];
    const shutdown = makeShutdown({ app, db, snapshots, log: () => {}, exit: (c) => exits.push(c) });
    await Promise.all([shutdown("first"), shutdown("second")]);
    expect(order).toEqual(["flush", "stop", "app.close", "db.close"]);
    expect(exits).toEqual([0]);
  });

  it("still shuts down if the last copy cannot be saved, and is not held up by a stuck connection", async () => {
    const logs: string[] = [];
    const snapshots = { flush: async () => { throw new Error("bucket down"); }, stop: () => {}, status: () => ({ enabled: true, lastSavedAt: null, ok: false }) } as Snapshots;
    const app = { close: () => new Promise(() => {}) } as never; // never finishes
    let closed = false;
    const db = { close: () => { closed = true; } } as never;
    const exits: number[] = [];
    const started = Date.now();
    await makeShutdown({ app, db, snapshots, log: (m) => logs.push(m), exit: (c) => exits.push(c), closeWaitMs: 50 })("stop");
    expect(Date.now() - started).toBeLessThan(2000);
    expect([closed, exits]).toEqual([true, [0]]);
    expect(logs.join(" ")).toContain("bucket down");
  });

  it("works when backup is off", async () => {
    const exits: number[] = [];
    await makeShutdown({ app: { close: async () => {} } as never, db: { close: () => {} } as never, snapshots: null, log: () => {}, exit: (c) => exits.push(c) })("stop");
    expect(exits).toEqual([0]);
  });
});

describe("health reports backups without revealing anything private", () => {
  it("says backup is off by default, and shows status when on", async () => {
    const db = openDb(":memory:");
    const off = buildApp(db);
    expect((await off.inject({ url: "/api/health" })).json().backup).toEqual({ enabled: false });
    await off.close();
    const on = buildApp(openDb(":memory:"), { backupStatus: () => ({ enabled: true, lastSavedAt: "2026-01-01T00:00:00.000Z", ok: true }) });
    const body = (await on.inject({ url: "/api/health" })).json();
    expect(body.backup).toEqual({ enabled: true, lastSavedAt: "2026-01-01T00:00:00.000Z", ok: true });
    expect(JSON.stringify(body)).not.toMatch(/secret|key|bucket|http/i);
    await on.close();
  });
});

describe("what the backup file contains", () => {
  it("is a complete database, so the bucket must be private", async () => {
    const b = await bucket();
    const db = openDb(path.join(tmp(), "ority.db"));
    makePoll(db);
    const snaps = startSnapshots({ db, s3: b.s3, prefix: "ority/", intervalMs: 3_600_000 });
    cleanups.push(() => { snaps.stop(); db.close(); });
    await snaps.flush();
    const packed = (await b.s3.get("ority/latest.db.gz"))!;
    expect(gunzipSync(packed).subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(packed.length).toBeLessThan(200_000); // small enough for any free storage plan
    const asText = gunzipSync(packed).toString("latin1");
    expect(asText).toContain("admin_hash"); // the scrambled organizer key lives in it, which is why it must stay private
  });
});

vi.setConfig({ testTimeout: 30_000 });
void T0;
