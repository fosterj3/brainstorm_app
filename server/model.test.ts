import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { createIdea, listColumns } from "./ideas";
import { getSettings, setSetting } from "./session";
import { createSession } from "./sessions";
import { getResults } from "./results";
import { applyAction } from "./session";
import { getVotes, join, setVote } from "./votes";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ority-"));
  dirs.push(d);
  return path.join(d, "test.db");
};

describe("votes.value migration", () => {
  it("adds a value column that defaults to 1, keeping every existing vote and tally", () => {
    const file = tmpFile();
    // Build a database the way it looked before the column existed.
    const old = openDb(file);
    const { id } = createSession(old, { title: "Old poll" }, 1000);
    const col = listColumns(old, id).find((c) => c.kind === "group")!;
    const a = createIdea(old, id, { columnId: col.id, title: "A" });
    const b = createIdea(old, id, { columnId: col.id, title: "B" });
    const ann = join(old, id, "Ann").token;
    const ben = join(old, id, "Ben").token;
    setSetting(old, id, "phase", "voting");
    setVote(old, id, ann, a.id, true);
    setVote(old, id, ann, b.id, true);
    setVote(old, id, ben, a.id, true);
    old.exec("ALTER TABLE votes DROP COLUMN value");
    expect((old.prepare("PRAGMA table_info(votes)").all() as { name: string }[]).some((c) => c.name === "value")).toBe(false);
    old.close();

    const db = openDb(file);
    const cols = db.prepare("PRAGMA table_info(votes)").all() as { name: string; notnull: number; dflt_value: string }[];
    expect(cols.find((c) => c.name === "value")).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(db.prepare("SELECT value FROM votes").all()).toEqual([{ value: 1 }, { value: 1 }, { value: 1 }]);
    expect(getVotes(db, id, ann)).toEqual([a.id, b.id]);
    setSetting(db, id, "phase", "locked");
    applyAction(db, id, "reveal", 2000);
    expect(getResults(db, id).rows.map((r) => [r.title, r.stars])).toEqual([["A", 2], ["B", 1]]);
    db.close();
  });

  it("is safe to run again on a database that already has the column", () => {
    const file = tmpFile();
    openDb(file).close();
    expect(() => openDb(file).close()).not.toThrow();
  });
});

describe("poll settings: method, mode and deadline", () => {
  const fresh = () => {
    const db = openDb(":memory:");
    return { db, id: createSession(db, { title: "P" }, 1000).id };
  };

  it("default to dot voting in a live session with no deadline", () => {
    const { db, id } = fresh();
    expect(getSettings(db, id)).toMatchObject({ method: "dots", mode: "live", deadline: null });
  });

  it("read back what is stored", () => {
    const { db, id } = fresh();
    setSetting(db, id, "method", "rank");
    setSetting(db, id, "mode", "poll");
    setSetting(db, id, "deadline", 1_900_000_000_000);
    expect(getSettings(db, id)).toMatchObject({ method: "rank", mode: "poll", deadline: 1_900_000_000_000 });
  });

  it("ignore unknown values instead of trusting them", () => {
    const { db, id } = fresh();
    setSetting(db, id, "method", "borda-ish");
    setSetting(db, id, "mode", "chaos");
    setSetting(db, id, "deadline", "soon");
    expect(getSettings(db, id)).toMatchObject({ method: "dots", mode: "live", deadline: null });
  });

  it("are per poll", () => {
    const { db, id } = fresh();
    const other = createSession(db, { title: "Q" }, 1000).id;
    setSetting(db, id, "method", "score");
    expect(getSettings(db, other).method).toBe("dots");
  });
});
