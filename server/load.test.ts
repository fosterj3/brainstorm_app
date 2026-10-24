import { describe, expect, it } from "vitest";
import { formatReport, runLoadTest } from "../scripts/loadtest";

/**
 * The 50-person load test from CLAUDE.md, run as part of the normal tests. People join, vote over live connections
 * with random pauses, some drop and come back, and then the results are checked against an independent tally.
 * See scripts/loadtest.ts, and `npm run loadtest` for bigger runs.
 */
const fast = { jitterMs: 100, arrivalMs: 500 };
const check = (r: Awaited<ReturnType<typeof runLoadTest>>) => {
  if (!r.ok) throw new Error(formatReport(r));
  return r;
};

describe("50 people at once, in one poll", () => {
  for (const method of ["dots", "rank", "score", "points"] as const) {
    it(`${method}: everyone's votes are kept and the results are right`, async () => {
      const r = check(await runLoadTest({ ...fast, participants: 50, polls: 1, method }));
      expect(r.people).toBe(50);
      expect(r.latency.join.n).toBe(50);
      expect(r.latency.submit.n).toBe(50);
    }, 60_000);
  }

  it("an open poll works the same way", async () => {
    check(await runLoadTest({ ...fast, participants: 50, polls: 1, method: "points", mode: "poll" }));
  }, 60_000);

  it("holds up when everyone drops their connection and comes back mid-vote", async () => {
    const r = check(await runLoadTest({ ...fast, participants: 50, polls: 1, method: "dots", reconnectShare: 1 }));
    expect(r.failures).toEqual([]);
  }, 60_000);
});

describe("many polls on one server at once", () => {
  it("20 people in each of 10 polls, all four methods, and the results survive a restart", async () => {
    const r = check(await runLoadTest({ ...fast, participants: 20, polls: 10, method: "mixed", options: 14, restartCheck: true }));
    expect(r.people).toBe(200);
    expect(r.restart).toBe("passed");
  }, 90_000);

  it("keeps polls separate: each poll's tally only counts its own people", async () => {
    // The independent tally is worked out per poll, so a vote leaking between polls would show up as a wrong result.
    check(await runLoadTest({ ...fast, participants: 25, polls: 6, method: "dots" }));
  }, 60_000);
});

describe("the load test itself can fail", () => {
  it("notices a vote that disappears after it was accepted", async () => {
    const r = await runLoadTest({
      ...fast, participants: 12, polls: 1, method: "dots",
      afterVoting: (db) => void db.prepare("DELETE FROM votes WHERE rowid = (SELECT MIN(rowid) FROM votes)").run(),
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/saved votes differ|scored|ranked/);
  }, 60_000);

  it("notices a vote that moves to another option", async () => {
    const r = await runLoadTest({
      ...fast, participants: 12, polls: 1, method: "score",
      afterVoting: (db) => void db.prepare("UPDATE votes SET value = CASE WHEN value = 5 THEN 1 ELSE 5 END WHERE rowid = (SELECT MAX(rowid) FROM votes)").run(),
    });
    expect(r.ok).toBe(false);
  }, 60_000);

  it("notices when the 95th percentile is slower than allowed", async () => {
    const r = await runLoadTest({ ...fast, participants: 10, polls: 1, method: "dots", maxP95Ms: 0 });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/95th percentile/);
  }, 60_000);
});
