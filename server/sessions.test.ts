import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { listColumns, listIdeas } from "./ideas";
import { createSession, deleteSession, getBoardMeta, getSummary, purgeIdle, updateBoardMeta, verifyAdmin } from "./sessions";
import { applyAction } from "./session";
import { join, setSubmitted, setVote } from "./votes";
import { VoteError } from "./errors";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

describe("creating a board", () => {
  it("returns a public code and a secret key, storing only a hash of the key", () => {
    const db = openDb(":memory:");
    const { id, adminKey } = createSession(db, { title: "  Offsite   priorities " }, 0);
    expect(id).toMatch(/^[2-9a-hj-km-np-z]{8}$/);
    expect(adminKey.length).toBeGreaterThanOrEqual(32);
    expect(getBoardMeta(db, id)!.title).toBe("Offsite priorities");
    const stored = db.prepare("SELECT admin_hash FROM sessions WHERE id = ?").get(id) as { admin_hash: string };
    expect(stored.admin_hash).not.toContain(adminKey);
  });
  it("gives every board its own code and key", () => {
    const db = openDb(":memory:");
    const a = createSession(db, { title: "A" }, 0);
    const b = createSession(db, { title: "B" }, 0);
    expect(a.id).not.toBe(b.id);
    expect(verifyAdmin(db, a.id, a.adminKey)).toBe(true);
    expect(verifyAdmin(db, a.id, b.adminKey)).toBe(false);
    expect(verifyAdmin(db, b.id, a.adminKey)).toBe(false);
  });
  it("rejects missing or wrong keys and unknown sessions", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "A" }, 0);
    expect(verifyAdmin(db, id, "")).toBe(false);
    expect(verifyAdmin(db, id, undefined)).toBe(false);
    expect(verifyAdmin(db, "nope", "x")).toBe(false);
  });
  it("requires a title", () => {
    expect(code(() => createSession(openDb(":memory:"), { title: "   " }, 0))).toBe("bad_input");
  });
  it("starts blank (just the group column) or from the example board", () => {
    const db = openDb(":memory:");
    const blank = createSession(db, { title: "Blank" }, 0).id;
    expect(listColumns(db, blank).map((c) => c.kind)).toEqual(["group"]);
    const example = createSession(db, { title: "Example", template: "example" }, 0).id;
    expect(listColumns(db, example).filter((c) => c.kind === "normal").length).toBeGreaterThan(1);
    expect(listIdeas(db, example).length).toBeGreaterThan(3);
    expect(listIdeas(db, blank)).toHaveLength(0);
  });
});

describe("board look", () => {
  it("updates title, subtitle and background, validating the color", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "A" }, 0);
    updateBoardMeta(db, id, { title: "B", subtitle: "Sub", bg: "#fff8e1" });
    expect(getBoardMeta(db, id)).toMatchObject({ title: "B", subtitle: "Sub", bg: "#fff8e1" });
    expect(code(() => updateBoardMeta(db, id, { bg: "pink" }))).toBe("bad_input");
    expect(code(() => updateBoardMeta(db, id, { title: " " }))).toBe("bad_input");
  });
});

describe("cleanup", () => {
  it("deletes idle sessions and everything in them, keeping active ones", () => {
    const db = openDb(":memory:");
    const old = createSession(db, { title: "Old", template: "example" }, 1000).id;
    const fresh = createSession(db, { title: "Fresh" }, 9_000_000).id;
    expect(purgeIdle(db, 10_000_000, 5_000_000)).toBe(1);
    expect(getBoardMeta(db, old)).toBeNull();
    expect(getBoardMeta(db, fresh)).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(old) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM columns WHERE session_id = ?").get(old) as { n: number }).n).toBe(0);
  });
});

describe("my boards: summary and delete", () => {
  it("summarises a board with headcounts and phase only", () => {
    const db = openDb(":memory:");
    const id = createSession(db, { title: "Mine", template: "example" }, 5).id;
    const a = join(db, id, "Ann").token;
    join(db, id, "Ben");
    applyAction(db, id, "start", 10);
    setVote(db, id, a, 1, true);
    setSubmitted(db, id, a, true);
    const s = getSummary(db, id)!;
    expect(s).toMatchObject({ id, title: "Mine", phase: "voting", joined: 2, submitted: 1, createdAt: 5 });
    expect(s.ideas).toBeGreaterThan(3);
    expect(Object.keys(s)).not.toContain("votes");
    expect(getSummary(db, "nope")).toBeNull();
  });
  it("deletes a board with everything in it and leaves other boards alone", () => {
    const db = openDb(":memory:");
    const gone = createSession(db, { title: "Gone", template: "example" }, 0).id;
    const kept = createSession(db, { title: "Kept", template: "example" }, 0).id;
    const t1 = join(db, gone, "Ann").token;
    const t2 = join(db, kept, "Ann").token;
    applyAction(db, gone, "start", 1);
    applyAction(db, kept, "start", 1);
    setVote(db, gone, t1, 1, true);
    const keptIdea = (db.prepare("SELECT id FROM ideas WHERE session_id = ? LIMIT 1").get(kept) as { id: number }).id;
    setVote(db, kept, t2, keptIdea, true);

    expect(deleteSession(db, gone)).toBe(true);
    expect(getBoardMeta(db, gone)).toBeNull();
    for (const table of ["columns", "ideas", "participants", "settings"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(gone) as { n: number }).n).toBe(0);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM votes WHERE token = ?").get(t1) as { n: number }).n).toBe(0);
    expect(getSummary(db, kept)).toMatchObject({ joined: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM votes WHERE token = ?").get(t2) as { n: number }).n).toBe(1);
    expect(deleteSession(db, gone)).toBe(false);
  });
});
