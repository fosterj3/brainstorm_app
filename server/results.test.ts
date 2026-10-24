import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "./db";
import { createColumn, createIdea } from "./ideas";
import { getResults, resultsToCsv } from "./results";
import { applyAction, updateSettings } from "./session";
import { newBoard } from "./testutil";
import { VoteError, addIdea, getSettings, join, setSetting, setSubmitted, setVote } from "./votes";

let db: DB;
let sid: string;
let people: string[];

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};
const T = 1_000;

/** Six ideas (ids 1-6), four people (Ann, Ben, Cy, Di), voting open with 3 stars each. */
beforeEach(() => {
  ({ db, sid } = newBoard(6));
  people = ["Ann", "Ben", "Cy", "Di"].map((n) => join(db, sid, n).token);
  applyAction(db, sid, "start", T);
});

const vote = (who: number, ...ideas: number[]) => ideas.forEach((i) => setVote(db, sid, people[who], i, true));
const reveal = () => {
  applyAction(db, sid, "lock", T);
  applyAction(db, sid, "reveal", T);
};

describe("tallying", () => {
  it("ranks ideas by stars, most first", () => {
    vote(0, 1, 2, 3);
    vote(1, 2, 3);
    vote(2, 3);
    reveal();
    const { rows } = getResults(db, sid);
    expect(rows.slice(0, 3).map((r) => [r.id, r.stars, r.rank])).toEqual([[3, 3, 1], [2, 2, 2], [1, 1, 3]]);
  });
  it("gives tied ideas the same rank and flags them, then skips ranks", () => {
    vote(0, 1, 2, 3);
    vote(1, 1, 2, 4);
    vote(2, 1, 5);
    reveal();
    const rows = getResults(db, sid).rows;
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect([by(1).rank, by(1).tied]).toEqual([1, false]); // 3 stars, alone
    expect([by(2).rank, by(2).tied]).toEqual([2, false]); // 2 stars, alone
    expect([by(3).rank, by(3).tied]).toEqual([3, true]); // 1 star, tied with 4 and 5
    expect([by(4).rank, by(5).rank]).toEqual([3, 3]);
    expect([by(6).rank, by(6).tied, by(6).stars]).toEqual([6, false, 0]); // rank skips to 6
  });
  it("lists ideas nobody starred, all tied at the bottom", () => {
    vote(0, 1);
    reveal();
    const zero = getResults(db, sid).rows.filter((r) => r.stars === 0);
    expect(zero).toHaveLength(5);
    expect(zero.every((r) => r.rank === 2 && r.tied)).toBe(true);
  });
  it("counts participation", () => {
    vote(0, 1, 2);
    vote(1, 2);
    setSubmitted(db, sid, people[0], true);
    reveal();
    expect(getResults(db, sid).totals).toEqual({ joined: 4, submitted: 1, voted: 2, stars: 3 });
  });
  it("includes participant-suggested ideas like any other", () => {
    setSetting(db, sid, "phase", "setup");
    const idea = addIdea(db, sid, people[0], { title: "Suggested" });
    setSetting(db, sid, "phase", "voting");
    vote(1, idea.id);
    reveal();
    const row = getResults(db, sid).rows[0];
    expect([row.title, row.column, row.stars]).toEqual(["Suggested", "Other options", 1]);
  });
  it("tallies each session separately", () => {
    const other = newBoard(2);
    const t = join(other.db, other.sid, "Zed").token;
    applyAction(other.db, other.sid, "start", T);
    setVote(other.db, other.sid, t, 1, true);
    vote(0, 1);
    reveal();
    expect(getResults(db, sid).totals.stars).toBe(1);
  });
});

describe("anonymous and named results", () => {
  it("never includes names when results are anonymous", () => {
    vote(0, 1);
    vote(1, 1);
    reveal();
    const results = getResults(db, sid);
    expect(results.named).toBe(false);
    expect(JSON.stringify(results)).not.toMatch(/Ann|Ben/);
    expect(results.rows.every((r) => r.voters === undefined)).toBe(true);
    expect(resultsToCsv(results)).not.toMatch(/Ann|Ben|Starred by/);
  });
  it("lists who starred what when the facilitator chose named results", () => {
    updateSettings(db, sid, { namedResults: true });
    vote(1, 1);
    vote(0, 1, 2);
    reveal();
    const rows = getResults(db, sid).rows;
    expect(rows.find((r) => r.id === 1)!.voters).toEqual(["Ann", "Ben"]);
    expect(rows.find((r) => r.id === 2)!.voters).toEqual(["Ann"]);
    expect(rows.find((r) => r.id === 3)!.voters).toEqual([]);
    expect(resultsToCsv(getResults(db, sid))).toContain("Ann; Ben");
  });
  it("cannot be switched to named while the results are showing", () => {
    reveal();
    expect(code(() => updateSettings(db, sid, { namedResults: true }))).toBe("bad_state");
  });
});

describe("reveal gating", () => {
  it("refuses results until they are revealed, even to the facilitator", () => {
    vote(0, 1);
    expect(code(() => getResults(db, sid))).toBe("bad_state");
    applyAction(db, sid, "lock", T);
    expect(code(() => getResults(db, sid))).toBe("bad_state");
    applyAction(db, sid, "reveal", T);
    expect(() => getResults(db, sid)).not.toThrow();
  });
  it("only reveals after locking, and can hide again", () => {
    expect(code(() => applyAction(db, sid, "reveal", T))).toBe("bad_state"); // still voting
    applyAction(db, sid, "lock", T);
    applyAction(db, sid, "reveal", T);
    expect(getSettings(db, sid)).toMatchObject({ phase: "revealed", revealed: true, locked: false });
    applyAction(db, sid, "hide", T);
    expect(getSettings(db, sid).phase).toBe("locked");
    expect(code(() => getResults(db, sid))).toBe("bad_state");
    expect(code(() => applyAction(db, sid, "hide", T))).toBe("bad_state");
  });
  it("keeps voting closed while results show, and does not allow reopening from there", () => {
    vote(0, 1);
    reveal();
    expect(code(() => setVote(db, sid, people[0], 2, true))).toBe("locked");
    expect(code(() => setVote(db, sid, people[0], 1, false))).toBe("locked");
    expect(code(() => setSubmitted(db, sid, people[0], true))).toBe("locked");
    expect(code(() => applyAction(db, sid, "reopen", T))).toBe("bad_state");
    expect(code(() => applyAction(db, sid, "extend", T, 60))).toBe("bad_state");
  });
  it("lets the facilitator hide, reopen and vote again", () => {
    reveal();
    applyAction(db, sid, "hide", T);
    applyAction(db, sid, "reopen", T);
    expect(() => setVote(db, sid, people[0], 1, true)).not.toThrow();
  });
});

describe("CSV export", () => {
  it("writes a header and one row per idea, with a byte-order mark for Excel", () => {
    vote(0, 1);
    reveal();
    const csv = resultsToCsv(getResults(db, sid));
    expect(csv.startsWith("﻿Rank,Tied,Code,Option,Group,Tag,Votes")).toBe(true);
    expect(csv.trim().split("\r\n")).toHaveLength(1 + 6);
  });
  it("quotes commas and quotes", () => {
    const col = createColumn(db, sid, { name: "Big, bold" });
    createIdea(db, sid, { columnId: col.id, title: 'Say "hi", then go' });
    vote(0, 7);
    reveal();
    const csv = resultsToCsv(getResults(db, sid));
    expect(csv).toContain('"Say ""hi"", then go"');
    expect(csv).toContain('"Big, bold"');
  });
  it("neutralises spreadsheet formulas typed into idea titles", () => {
    const col = createColumn(db, sid, { name: "X" });
    for (const title of ["=HYPERLINK(\"http://evil\",\"x\")", "+1+1", "-2+3", "@SUM(A1)"]) createIdea(db, sid, { columnId: col.id, title });
    reveal();
    const lines = resultsToCsv(getResults(db, sid)).split("\r\n");
    expect(lines.some((l) => /,[=+@-]/.test(l.replace(/,'[=+@-]/g, "")))).toBe(false);
    expect(lines.join("\n")).toContain("'=HYPERLINK");
    expect(lines.join("\n")).toContain("'+1+1");
    expect(lines.join("\n")).toContain("'@SUM");
  });
});

describe("ungrouped options in results", () => {
  it("flags ungrouped rows and leaves their Group blank in the CSV", () => {
    setSetting(db, sid, "phase", "setup");
    addIdea(db, sid, people[0], { title: "Loose" });
    setSetting(db, sid, "phase", "voting");
    reveal();
    const results = getResults(db, sid);
    const row = results.rows.find((r) => r.title === "Loose")!;
    expect(row.grouped).toBe(false);
    expect(results.rows.filter((r) => r.grouped).length).toBe(results.rows.length - 1);
    const line = resultsToCsv(results).split("\r\n").find((l) => l.includes("Loose"))!;
    expect(line.split(",").slice(3, 6)).toEqual(["Loose", "", ""]);
  });
});
