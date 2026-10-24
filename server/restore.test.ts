import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { createColumn, createIdea, listIdeas, mergeIdeas } from "./ideas";
import { parseResultsCsv, restoreResults } from "./restore";
import { getResults, resultsToCsv } from "./results";
import { applyAction, getSettings, updateSettings } from "./session";
import { createSession } from "./sessions";
import { newBoard } from "./testutil";
import { VoteError, join, setVote } from "./votes";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};
const T = 1_000;

/** A finished board: three ideas starred 3, 2 and 2 times (a tie), one idea nobody starred. */
function finishedBoard(named = false) {
  const b = newBoard(0);
  const col = createColumn(b.db, b.sid, { name: "Ways of working", description: "x" });
  const ideas = ["=SUM(1,1) Evil title", "Plain, with comma", 'Has "quotes"', "Nobody's pick"].map((title, i) =>
    createIdea(b.db, b.sid, { columnId: col.id, title, audience: i === 0 ? "For managers" : "" }),
  );
  const people = ["Ann", "Ben", "Cy"].map((n) => join(b.db, b.sid, n).token);
  if (named) updateSettings(b.db, b.sid, { namedResults: true });
  applyAction(b.db, b.sid, "start", T);
  [[0, 1, 2], [0, 1], [0, 2]].forEach((picks, p) => picks.forEach((k) => setVote(b.db, b.sid, people[p], ideas[k].id, true)));
  applyAction(b.db, b.sid, "lock", T);
  applyAction(b.db, b.sid, "reveal", T);
  return { ...b, ideas };
}

const shape = (r: ReturnType<typeof getResults>) =>
  r.rows.map((x) => ({ title: x.title, column: x.column, code: x.code, audience: x.audience, stars: x.stars, rank: x.rank, tied: x.tied, voters: x.voters }));

describe("restoring results from a downloaded CSV", () => {
  it("rebuilds the same ranking, ties and columns (anonymous)", () => {
    const { db, sid } = finishedBoard();
    const original = getResults(db, sid);
    const csv = resultsToCsv(original);
    const restored = restoreResults(db, { title: "Restored", csv }, 5);
    const again = getResults(db, restored.id);
    expect(shape(again)).toEqual(shape(original));
    expect(again.rows.map((r) => r.stars)).toEqual([3, 2, 2, 0]);
    expect(again.rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(again.named).toBe(false);
    expect(again.restored).toBe(true);
  });

  it("keeps the names when the file lists who starred what", () => {
    const { db, sid } = finishedBoard(true);
    const original = getResults(db, sid);
    const restored = restoreResults(db, { title: "Restored", csv: resultsToCsv(original) });
    const again = getResults(db, restored.id);
    expect(again.named).toBe(true);
    expect(shape(again)).toEqual(shape(original));
    expect(again.rows[0].voters).toEqual(["Ann", "Ben", "Cy"]);
  });

  it("round-trips titles that start with spreadsheet formula characters", () => {
    const { db, sid } = finishedBoard();
    const csv = resultsToCsv(getResults(db, sid));
    expect(csv).toContain("'=SUM(1,1)"); // neutralised in the file
    const again = getResults(db, restoreResults(db, { title: "R", csv }).id);
    expect(again.rows.some((r) => r.title === "=SUM(1,1) Evil title")).toBe(true); // restored exactly
  });

  it("opens with the results showing, readable by the facilitator straight away", () => {
    const { db, sid } = finishedBoard();
    const r = restoreResults(db, { title: "Restored", csv: resultsToCsv(getResults(db, sid)) });
    expect(getSettings(db, r.id)).toMatchObject({ phase: "revealed", revealed: true });
    expect(() => getResults(db, r.id)).not.toThrow();
    expect(getResults(db, r.id).totals).toMatchObject({ joined: 0, submitted: 0, voted: 0, stars: 7 });
  });

  it("recomputes ranks from the stars, ignoring the file's Rank and Tied columns", () => {
    const csv = "Rank,Tied,Idea,Stars\n9,yes,Low,1\n1,,High,5\n5,yes,Mid,3\n";
    const { db, id } = openDbWith(csv);
    const rows = getResults(db, id).rows;
    expect(rows.map((r) => [r.title, r.rank])).toEqual([["High", 1], ["Mid", 2], ["Low", 3]]);
  });

  it("accepts a hand-made file with just Idea and Stars, putting options in the ungrouped section", () => {
    const { db, id } = openDbWith("Idea,Stars\nAlpha,4\nBeta,1\n");
    const r = getResults(db, id);
    expect(r.rows.map((x) => [x.title, x.stars, x.column])).toEqual([["Alpha", 4, "Other options"], ["Beta", 1, "Other options"]]);
  });

  it("can be continued: reopening voting adds new stars on top of the restored ones", () => {
    const { db, id } = openDbWith("Idea,Stars\nAlpha,4\nBeta,1\n");
    applyAction(db, id, "hide", T);
    applyAction(db, id, "reopen", T);
    const t = join(db, id, "New person").token;
    const beta = listIdeas(db, id).find((i) => i.title === "Beta")!;
    setVote(db, id, t, beta.id, true);
    applyAction(db, id, "lock", T);
    applyAction(db, id, "reveal", T);
    expect(getResults(db, id).rows.find((r) => r.title === "Beta")!.stars).toBe(2);
  });

  it("keeps restored stars when two ideas are merged", () => {
    const { db, id } = openDbWith("Idea,Stars\nAlpha,4\nBeta,1\n");
    const [a, b] = listIdeas(db, id);
    mergeIdeas(db, id, b.id, a.id);
    expect(getResults(db, id).rows).toHaveLength(1);
    expect(getResults(db, id).rows[0].stars).toBe(5);
  });

  it("leaves every other board untouched", () => {
    const other = newBoard(2);
    const before = JSON.stringify(listIdeas(other.db, other.sid));
    restoreResults(other.db, { title: "R", csv: "Idea,Stars\nA,1\n" });
    expect(JSON.stringify(listIdeas(other.db, other.sid))).toBe(before);
    expect((other.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(2);
  });
});

function openDbWith(csv: string) {
  const db = openDb(":memory:");
  const r = restoreResults(db, { title: "R", csv });
  return { db, id: r.id };
}

describe("rejecting files that are not results", () => {
  it("needs Idea and Stars columns", () => {
    expect(code(() => parseResultsCsv("Foo,Bar\n1,2"))).toBe("bad_input");
    expect(code(() => parseResultsCsv("Idea,Notes\nA,hi"))).toBe("bad_input");
    expect(code(() => parseResultsCsv(""))).toBe("bad_input");
  });
  it("needs whole, non-negative star counts and tells you which row", () => {
    for (const bad of ["-1", "1.5", "lots", ""]) {
      let err: VoteError | null = null;
      try {
        parseResultsCsv(`Idea,Stars\nFine,2\nBroken,${bad}\n`);
      } catch (e) {
        err = e as VoteError;
      }
      expect(err?.code).toBe("bad_input");
      expect(err?.message).toContain("Row 3");
    }
  });
  it("needs at least one idea, skips blank titles, and caps the size", () => {
    expect(code(() => parseResultsCsv("Idea,Stars\n,3\n"))).toBe("bad_input");
    expect(parseResultsCsv("Idea,Stars\nA,1\n,2\n").skipped).toBe(1);
    const big = "Idea,Stars\n" + Array.from({ length: 301 }, (_, i) => `I${i},1`).join("\n");
    expect(code(() => parseResultsCsv(big))).toBe("bad_input");
  });
  it("creates nothing when the file is bad", () => {
    const db = openDb(":memory:");
    expect(code(() => restoreResults(db, { title: "R", csv: "Idea,Stars\nA,nope\n" }))).toBe("bad_input");
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  });
  it("needs a title for the new board", () => {
    expect(code(() => restoreResults(openDb(":memory:"), { title: "  ", csv: "Idea,Stars\nA,1\n" }))).toBe("bad_input");
  });
  it("is not affected by createSession being unused here", () => {
    expect(createSession(openDb(":memory:"), { title: "x" }).id).toHaveLength(8);
  });
});

describe("restoring from the newer CSV headers", () => {
  it("reads Option, Group, Tag, Votes and Voted by, and leaves a blank group ungrouped", () => {
    const { db, id } = openDbWith("Rank,Tied,Code,Option,Group,Tag,Votes,Voted by\n1,,A1,Alpha,Team,For all,4,Ann; Ben\n2,,,Beta,,,1,\n");
    const r = getResults(db, id);
    expect(r.named).toBe(true);
    expect(r.rows.map((x) => [x.title, x.stars, x.column, x.audience, x.voters])).toEqual([
      ["Alpha", 4, "Team", "For all", ["Ann", "Ben"]],
      ["Beta", 1, "Other options", "", []],
    ]);
  });
  it("still reads CSVs downloaded before the rename", () => {
    const { db, id } = openDbWith("Rank,Tied,Code,Idea,Column,Audience,Stars,Starred by\n1,,A1,Alpha,Team,For all,4,Ann\n");
    expect(getResults(db, id).rows[0]).toMatchObject({ title: "Alpha", stars: 4, column: "Team", audience: "For all", voters: ["Ann"] });
  });
});
