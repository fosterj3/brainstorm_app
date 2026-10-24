import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./index";
import { openDb } from "./db";
import { createSession } from "./sessions";
import { getResults } from "./results";
import { applyAction } from "./session";
import { join, setVote } from "./votes";
import { listIdeas } from "./ideas";
import { openStorage, STORAGE_KINDS, type Storage } from "./storage";

const tmp: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ority-store-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * What every storage backend has to do. Run this against a new adapter before trusting it: if it passes, and the
 * load test passes, the rest of Ority will work on it.
 */
function storageContract(name: string, open: () => Storage) {
  describe(`storage contract: ${name}`, () => {
    const fresh = () => {
      const s = open();
      s.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);");
      return s;
    };

    it("reports what it is", () => {
      const s = open();
      expect(typeof s.kind).toBe("string");
      expect(typeof s.location).toBe("string");
      s.close();
    });

    it("runs statements: run reports changes and the new id, get returns a row or undefined, all returns a list", () => {
      const s = fresh();
      const r = s.prepare("INSERT INTO parent (name) VALUES (?)").run("a");
      expect(r.changes).toBe(1);
      expect(Number(r.lastInsertRowid)).toBe(1);
      s.prepare("INSERT INTO parent (name) VALUES (?)").run("b");
      expect(s.prepare("SELECT name FROM parent WHERE id = ?").get(2)).toEqual({ name: "b" });
      expect(s.prepare("SELECT name FROM parent WHERE id = ?").get(99)).toBeUndefined();
      expect(s.prepare("SELECT name FROM parent ORDER BY id").all()).toEqual([{ name: "a" }, { name: "b" }]);
      expect(s.prepare("SELECT name FROM parent WHERE id > ?").all(99)).toEqual([]);
      expect(s.prepare("DELETE FROM parent WHERE name = ?").run("nobody").changes).toBe(0);
      s.close();
    });

    it("keeps values safe: parameters are never read as SQL", () => {
      const s = fresh();
      s.prepare("INSERT INTO parent (name) VALUES (?)").run("x'); DROP TABLE parent; --");
      expect(s.prepare("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 1 });
      s.close();
    });

    it("saves a transaction as a whole, and gives back what the function returns", () => {
      const s = fresh();
      const result = s.transaction(() => {
        s.prepare("INSERT INTO parent (name) VALUES (?)").run("one");
        s.prepare("INSERT INTO parent (name) VALUES (?)").run("two");
        return 42;
      })();
      expect(result).toBe(42);
      expect(s.prepare("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 2 });
      s.close();
    });

    it("undoes the whole transaction when something inside it throws", () => {
      const s = fresh();
      expect(() =>
        s.transaction(() => {
          s.prepare("INSERT INTO parent (name) VALUES (?)").run("lost");
          throw new Error("stop");
        })(),
      ).toThrow("stop");
      expect(s.prepare("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 0 });
      s.close();
    });

    it("lets a transaction start inside another one, and undoes both if the outer one fails", () => {
      const s = fresh();
      const inner = s.transaction(() => s.prepare("INSERT INTO parent (name) VALUES (?)").run("inner"));
      expect(() =>
        s.transaction(() => {
          inner();
          throw new Error("outer fails");
        })(),
      ).toThrow("outer fails");
      expect(s.prepare("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 0 });
      s.transaction(() => inner())();
      expect(s.prepare("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 1 });
      s.close();
    });

    it("enforces relationships, so deleting a parent deletes what belongs to it", () => {
      const s = fresh();
      s.prepare("INSERT INTO parent (name) VALUES ('p')").run();
      s.prepare("INSERT INTO child (parent_id) VALUES (1)").run();
      expect(() => s.prepare("INSERT INTO child (parent_id) VALUES (99)").run()).toThrow(); // no such parent
      s.prepare("DELETE FROM parent WHERE id = 1").run();
      expect(s.prepare("SELECT COUNT(*) AS n FROM child").get()).toEqual({ n: 0 });
      s.close();
    });

    it("makes a complete copy that can be opened on its own", async () => {
      const dir = tmpDir();
      const s = fresh();
      s.prepare("INSERT INTO parent (name) VALUES (?)").run("kept");
      const file = path.join(dir, "nested", "copy.db");
      await s.backup(file);
      s.prepare("INSERT INTO parent (name) VALUES (?)").run("after the copy");
      s.close();
      const copy = openStorage({ kind: s.kind, file });
      expect(copy.prepare("SELECT name FROM parent").all()).toEqual([{ name: "kept" }]);
      copy.close();
    });
  });
}

storageContract("sqlite in memory", () => openStorage({ kind: "sqlite", file: ":memory:" }));
storageContract("sqlite in a file", () => openStorage({ kind: "sqlite", file: path.join(tmpDir(), "contract.db") }));

describe("choosing a storage backend", () => {
  it("knows sqlite, and says clearly when asked for something it does not have", () => {
    expect(STORAGE_KINDS).toEqual(["sqlite"]);
    expect(() => openStorage({ kind: "dynamo", file: ":memory:" })).toThrow(/Unknown storage "dynamo".*sqlite/);
    expect(() => openDb(":memory:", "nope")).toThrow(/Unknown storage/);
  });
  it("creates the folder for a file database that does not exist yet", () => {
    const file = path.join(tmpDir(), "does", "not", "exist", "yet.db");
    const s = openStorage({ kind: "sqlite", file });
    expect(fs.existsSync(file)).toBe(true);
    s.close();
  });
});

describe("backing up a real poll", () => {
  it("keeps every poll, vote and result, and the copy works as a database", async () => {
    const dir = tmpDir();
    const db = openDb(path.join(dir, "live.db"));
    const { id } = createSession(db, { title: "Backup me", mode: "poll", options: ["A", "B", "C"], deadline: Date.now() + 86_400_000 });
    const ann = join(db, id, "Ann").token;
    const [first] = listIdeas(db, id);
    setVote(db, id, ann, first.id, true);
    const copy = path.join(dir, "backups", "copy.db");
    await db.backup(copy);
    // The live database keeps changing; the copy does not.
    setVote(db, id, join(db, id, "Ben").token, first.id, true);
    db.close();

    const restored = openDb(copy);
    applyAction(restored, id, "close", Date.now());
    expect(getResults(restored, id).rows[0]).toMatchObject({ title: "A", stars: 1 });
    restored.close();
  });
});

describe("health and settings endpoints", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("health says the database answers, and reveals nothing private", async () => {
    app = buildApp(openDb(":memory:"));
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, storage: "sqlite" });
    expect(JSON.stringify(body)).not.toMatch(/\.db|:memory:|\//); // no file paths
  });

  it("health says 503 when the database is gone", async () => {
    const db = openDb(":memory:");
    app = buildApp(db);
    db.close();
    const res = await app.inject({ url: "/api/health" });
    expect([res.statusCode, res.json().ok]).toEqual([503, false]);
  });

  it("config says whether to show the demo notice, and only that", async () => {
    app = buildApp(openDb(":memory:"));
    expect((await app.inject({ url: "/api/config" })).json()).toEqual({ demo: false });
    await app.close();
    app = buildApp(openDb(":memory:"), { demoNotice: true });
    expect((await app.inject({ url: "/api/config" })).json()).toEqual({ demo: true });
  });
});
