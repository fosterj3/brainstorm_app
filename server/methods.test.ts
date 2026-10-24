import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./index";
import type { DB } from "./db";
import { openDb } from "./db";
import { createColumn, createIdea, deleteIdea, listColumns, mergeIdeas } from "./ideas";
import { getResults, resultsToCsv } from "./results";
import { applyAction, getSettings, setSetting, updateSettings, type Method } from "./session";
import { createSession } from "./sessions";
import { newBoard } from "./testutil";
import { VoteError, getBallot, getVotes, join, setBallot, setSubmitted, setVote } from "./votes";

const T = 1_000;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

/** A poll with `n` options (ids 1..n) and named people, using `method`, with voting open. */
function poll(method: Method, n: number, names: string[] = ["Ann", "Ben", "Cy"]) {
  const b = newBoard(n);
  updateSettings(b.db, b.sid, { method });
  const people = names.map((name) => join(b.db, b.sid, name).token);
  applyAction(b.db, b.sid, "start", T);
  const ballot = (who: number, values: Record<number, number>) => setBallot(b.db, b.sid, people[who], values, T);
  const reveal = () => {
    applyAction(b.db, b.sid, "lock", T);
    applyAction(b.db, b.sid, "reveal", T);
    return getResults(b.db, b.sid);
  };
  return { ...b, people, ballot, reveal };
}
/** Turn "options in order, best first" into the rank map a ballot uses. */
const order = (...ids: number[]) => Object.fromEntries(ids.map((id, i) => [id, i + 1]));
const summary = (r: ReturnType<typeof getResults>) => r.rows.map((x) => [x.id, x.stars, x.rank, x.tied]);

describe("choosing the voting method", () => {
  it("defaults to dots and can be changed only while setting up", () => {
    const { db, sid } = newBoard(2);
    expect(getSettings(db, sid).method).toBe("dots");
    updateSettings(db, sid, { method: "rank" });
    expect(getSettings(db, sid).method).toBe("rank");
    applyAction(db, sid, "start", T);
    expect(code(() => updateSettings(db, sid, { method: "score" }))).toBe("bad_state");
    expect(getSettings(db, sid).method).toBe("rank");
  });
  it("rejects an unknown method, and accepts one when a poll is created", () => {
    const { db, sid } = newBoard(2);
    expect(code(() => updateSettings(db, sid, { method: "borda" as Method }))).toBe("bad_input");
    const made = createSession(db, { title: "P", method: "points" }, T);
    expect(getSettings(db, made.id).method).toBe("points");
    expect(code(() => createSession(db, { title: "P", method: "nope" }, T))).toBe("bad_input");
  });
  it("keeps dot voting and ballots separate: each rejects the other method", () => {
    const dots = newBoard(3);
    const d = join(dots.db, dots.sid, "Ann").token;
    applyAction(dots.db, dots.sid, "start", T);
    expect(code(() => setBallot(dots.db, dots.sid, d, { 1: 1 }, T))).toBe("bad_state");
    const p = poll("score", 3);
    expect(code(() => setVote(p.db, p.sid, p.people[0], 1, true, T))).toBe("bad_state");
  });
});

describe("rank order ballots", () => {
  it("accepts a full ranking and stores it as the person's own ballot", () => {
    const p = poll("rank", 4);
    const r = p.ballot(0, order(3, 1, 4, 2));
    expect(r.ballot).toEqual({ 3: 1, 1: 2, 4: 3, 2: 4 });
    expect(getBallot(p.db, p.sid, p.people[0])).toEqual({ 3: 1, 1: 2, 4: 3, 2: 4 });
    expect(getBallot(p.db, p.sid, p.people[1])).toEqual({});
  });
  it("replaces the old ballot instead of adding to it, and an empty ballot clears it", () => {
    const p = poll("rank", 4);
    p.ballot(0, order(1, 2, 3, 4));
    p.ballot(0, order(4, 3));
    expect(getBallot(p.db, p.sid, p.people[0])).toEqual({ 4: 1, 3: 2 });
    p.ballot(0, {});
    expect(getVotes(p.db, p.sid, p.people[0])).toEqual([]);
  });
  it("rejects duplicate places, gaps, ranks that do not start at 1, and non-whole numbers", () => {
    const p = poll("rank", 4);
    expect(code(() => p.ballot(0, { 1: 1, 2: 1 }))).toBe("bad_input");
    expect(code(() => p.ballot(0, { 1: 1, 2: 3 }))).toBe("bad_input");
    expect(code(() => p.ballot(0, { 1: 2, 2: 3 }))).toBe("bad_input");
    expect(code(() => p.ballot(0, { 1: 1.5 }))).toBe("bad_input");
    expect(code(() => p.ballot(0, { 1: "1" as unknown as number }))).toBe("bad_input");
    expect(getVotes(p.db, p.sid, p.people[0])).toEqual([]);
  });
  it("lets people rank only their top 5 when there are more than 10 options", () => {
    const p = poll("rank", 12);
    expect(() => p.ballot(0, order(1, 2, 3, 4, 5))).not.toThrow();
    expect(code(() => p.ballot(0, order(1, 2, 3, 4, 5, 6)))).toBe("cap_reached");
    const ten = poll("rank", 10);
    expect(() => ten.ballot(0, order(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))).not.toThrow();
  });
  it("rejects options that do not exist or belong to another poll", () => {
    const p = poll("rank", 3);
    const other = poll("rank", 3);
    expect(code(() => p.ballot(0, order(99)))).toBe("unknown_idea");
    // Option ids 1..3 exist in both polls, so use one that exists only in the other poll.
    const extra = createIdea(other.db, other.sid, { columnId: other.col.id, title: "Only there" });
    setBallot(other.db, other.sid, other.people[0], order(extra.id), T);
    expect(code(() => setBallot(p.db, p.sid, p.people[0], order(extra.id), T))).toBe("unknown_idea");
  });
  it("only works for people who joined this poll", () => {
    const a = poll("rank", 3);
    const b = poll("rank", 3);
    expect(code(() => setBallot(b.db, b.sid, a.people[0], order(1, 2, 3), T))).toBe("unknown_participant");
    expect(code(() => setBallot(a.db, a.sid, "not-a-token", order(1), T))).toBe("unknown_participant");
  });
  it("is closed before voting starts and after it is locked", () => {
    const b = newBoard(3);
    updateSettings(b.db, b.sid, { method: "rank" });
    const t = join(b.db, b.sid, "Ann").token;
    expect(code(() => setBallot(b.db, b.sid, t, order(1), T))).toBe("not_started");
    applyAction(b.db, b.sid, "start", T);
    setBallot(b.db, b.sid, t, order(1, 2, 3), T);
    applyAction(b.db, b.sid, "lock", T);
    expect(code(() => setBallot(b.db, b.sid, t, order(3, 2, 1), T))).toBe("locked");
    expect(getBallot(b.db, b.sid, t)).toEqual({ 1: 1, 2: 2, 3: 3 });
  });
  it("needs every slot filled before it can be submitted", () => {
    const p = poll("rank", 4);
    p.ballot(0, order(1, 2));
    expect(code(() => setSubmitted(p.db, p.sid, p.people[0], true, T))).toBe("nothing_to_submit");
    p.ballot(0, order(1, 2, 3, 4));
    expect(setSubmitted(p.db, p.sid, p.people[0], true, T)).toBe(true);
  });
});

describe("rank order results (Borda count)", () => {
  it("gives 1st place as many points as there are options, down to 1 for last, and sorts by total", () => {
    const p = poll("rank", 4);
    p.ballot(0, order(1, 2, 3, 4));
    p.ballot(1, order(2, 1, 4, 3));
    p.ballot(2, order(1, 3, 2, 4));
    const r = p.reveal();
    expect(r.method).toBe("rank");
    expect(summary(r)).toEqual([[1, 11, 1, false], [2, 9, 2, false], [3, 6, 3, false], [4, 4, 4, false]]);
  });
  it("shares a rank between equal totals and then skips (1, 2, 2, 4)", () => {
    const p = poll("rank", 4, ["Ann", "Ben"]);
    p.ballot(0, order(1, 2, 3, 4));
    p.ballot(1, order(1, 3, 2, 4));
    const rows = p.reveal().rows;
    expect(rows.map((x) => [x.id, x.stars, x.rank, x.tied])).toEqual([[1, 8, 1, false], [2, 5, 2, true], [3, 5, 2, true], [4, 2, 4, false]]);
  });
  it("in a long list, 1st place earns 5 points, and options nobody ranked earn none", () => {
    const p = poll("rank", 12);
    p.ballot(0, order(3, 1, 2, 4, 5));
    const rows = p.reveal().rows;
    expect(rows.slice(0, 5).map((x) => [x.id, x.stars])).toEqual([[3, 5], [1, 4], [2, 3], [4, 2], [5, 1]]);
    expect(rows.slice(5).every((x) => x.stars === 0 && x.rank === 6 && x.tied)).toBe(true);
  });
  it("still tallies sensibly if an option is deleted after people ranked", () => {
    const p = poll("rank", 4, ["Ann", "Ben"]);
    p.ballot(0, order(1, 2, 3, 4));
    p.ballot(1, order(2, 1, 3, 4));
    deleteIdea(p.db, p.sid, 1);
    const r = p.reveal();
    expect(r.rows.map((x) => x.id)).toEqual([2, 3, 4]);
    expect(r.rows.map((x) => x.stars)).toEqual([...r.rows.map((x) => x.stars)].sort((a, b) => b - a));
    expect(r.rows.every((x) => x.stars >= 0)).toBe(true);
  });
});

describe("score ballots and results", () => {
  it("accepts scores from 1 to 5, lets people skip options, and rejects anything else", () => {
    const p = poll("score", 4);
    expect(() => p.ballot(0, { 1: 5, 3: 1 })).not.toThrow();
    for (const bad of [0, 6, -1, 2.5]) expect(code(() => p.ballot(0, { 1: bad }))).toBe("bad_input");
    expect(getBallot(p.db, p.sid, p.people[0])).toEqual({ 1: 5, 3: 1 });
  });
  it("needs at least one score before it can be submitted", () => {
    const p = poll("score", 3);
    expect(code(() => setSubmitted(p.db, p.sid, p.people[0], true, T))).toBe("nothing_to_submit");
    p.ballot(0, { 2: 3 });
    expect(setSubmitted(p.db, p.sid, p.people[0], true, T)).toBe(true);
  });
  it("averages the scores, breaks ties by number of ratings, and puts unrated options last", () => {
    const p = poll("score", 4);
    p.ballot(0, { 1: 5, 3: 4 });
    p.ballot(1, { 1: 3, 3: 4 });
    p.ballot(2, { 2: 4 });
    const r = p.reveal();
    expect(r.rows.map((x) => [x.id, x.stars, x.ratings, x.rank, x.tied])).toEqual([
      [1, 4, 2, 1, true], // average 4 from two ratings, tied with option 3
      [3, 4, 2, 1, true],
      [2, 4, 1, 3, false], // same average, but only one rating
      [4, 0, 0, 4, false], // nobody rated it
    ]);
    expect(r.totals.stars).toBe(5); // five ratings in total
  });
  it("rounds averages to two places for display, without changing the order", () => {
    const p = poll("score", 2);
    p.ballot(0, { 1: 4, 2: 5 });
    p.ballot(1, { 1: 4, 2: 5 });
    p.ballot(2, { 1: 3, 2: 4 });
    const rows = p.reveal().rows;
    expect(rows.map((x) => [x.id, x.stars])).toEqual([[2, 4.67], [1, 3.67]]);
  });
});

describe("100 point ballots and results", () => {
  it("accepts any split up to 100, drops zeros, and rejects negatives and totals over 100", () => {
    const p = poll("points", 4);
    expect(() => p.ballot(0, { 1: 60, 2: 0, 3: 10 })).not.toThrow();
    expect(getBallot(p.db, p.sid, p.people[0])).toEqual({ 1: 60, 3: 10 });
    expect(code(() => p.ballot(0, { 1: 60, 2: 41 }))).toBe("cap_reached");
    expect(code(() => p.ballot(0, { 1: -5 }))).toBe("bad_input");
    expect(code(() => p.ballot(0, { 1: 10.5 }))).toBe("bad_input");
    expect(getBallot(p.db, p.sid, p.people[0])).toEqual({ 1: 60, 3: 10 });
  });
  it("can be submitted only when exactly 100 points are used", () => {
    const p = poll("points", 3);
    p.ballot(0, { 1: 60, 2: 30 });
    expect(code(() => setSubmitted(p.db, p.sid, p.people[0], true, T))).toBe("nothing_to_submit");
    p.ballot(0, { 1: 60, 2: 40 });
    expect(setSubmitted(p.db, p.sid, p.people[0], true, T)).toBe(true);
  });
  it("removes the submitted mark if a later edit leaves the ballot unfinished", () => {
    const p = poll("points", 3);
    p.ballot(0, { 1: 100 });
    setSubmitted(p.db, p.sid, p.people[0], true, T);
    const r = p.ballot(0, { 1: 90 });
    expect(r.submitted).toBe(false);
    expect(p.db.prepare("SELECT submitted FROM participants WHERE token = ?").get(p.people[0])).toEqual({ submitted: 0 });
  });
  it("adds up the points and ranks by total", () => {
    const p = poll("points", 4);
    p.ballot(0, { 1: 50, 2: 30, 3: 20 });
    p.ballot(1, { 1: 30, 2: 30, 3: 40 });
    p.ballot(2, { 1: 20, 2: 50, 3: 30 });
    expect(summary(p.reveal())).toEqual([[2, 110, 1, false], [1, 100, 2, false], [3, 90, 3, false], [4, 0, 4, false]]);
  });
  it("shares a rank between equal totals and then skips (1, 2, 2, 4)", () => {
    const p = poll("points", 4, ["Ann", "Ben"]);
    p.ballot(0, { 1: 60, 2: 20, 3: 20 });
    p.ballot(1, { 1: 40, 2: 30, 3: 30 });
    expect(summary(p.reveal())).toEqual([[1, 100, 1, false], [2, 50, 2, true], [3, 50, 2, true], [4, 0, 4, false]]);
  });
});

describe("dot results are unchanged", () => {
  it("still count one per vote and share ranks", () => {
    const b = newBoard(4);
    const people = ["Ann", "Ben"].map((n) => join(b.db, b.sid, n).token);
    applyAction(b.db, b.sid, "start", T);
    setVote(b.db, b.sid, people[0], 1, true, T);
    setVote(b.db, b.sid, people[0], 2, true, T);
    setVote(b.db, b.sid, people[1], 1, true, T);
    setVote(b.db, b.sid, people[1], 3, true, T);
    applyAction(b.db, b.sid, "lock", T);
    applyAction(b.db, b.sid, "reveal", T);
    expect(summary(getResults(b.db, b.sid))).toEqual([[1, 2, 1, false], [2, 1, 2, true], [3, 1, 2, true], [4, 0, 4, false]]);
  });
});

describe("results stay private and gated for every method", () => {
  for (const method of ["dots", "rank", "score", "points"] as const) {
    it(`${method}: nothing is tallied until the organizer reveals`, () => {
      const p = poll(method, 3);
      if (method === "dots") setVote(p.db, p.sid, p.people[0], 1, true, T);
      else p.ballot(0, method === "rank" ? order(1, 2, 3) : method === "score" ? { 1: 5 } : { 1: 100 });
      expect(code(() => getResults(p.db, p.sid))).toBe("bad_state");
      applyAction(p.db, p.sid, "lock", T);
      expect(code(() => getResults(p.db, p.sid))).toBe("bad_state");
      applyAction(p.db, p.sid, "reveal", T);
      expect(() => getResults(p.db, p.sid)).not.toThrow();
    });
  }
  it("names appear only when the organizer chose named results, and show each person's value", () => {
    const p = poll("score", 2, ["Ann", "Ben"]);
    p.ballot(0, { 1: 5 });
    p.ballot(1, { 1: 3 });
    expect(JSON.stringify(p.reveal())).not.toMatch(/Ann|Ben/);

    const q = poll("points", 2, ["Ann", "Ben"]);
    setSetting(q.db, q.sid, "named_results", true);
    q.ballot(0, { 1: 70, 2: 30 });
    q.ballot(1, { 1: 100 });
    expect(q.reveal().rows.find((r) => r.id === 1)!.voters).toEqual(["Ann: 70", "Ben: 100"]);

    const r = poll("rank", 2, ["Ann", "Ben"]);
    setSetting(r.db, r.sid, "named_results", true);
    r.ballot(0, order(2, 1));
    expect(r.reveal().rows.find((x) => x.id === 2)!.voters).toEqual(["Ann: #1"]);
  });
  it("keeps polls separate: one poll's ballots never reach another poll's tally", () => {
    const a = poll("points", 2);
    const b = poll("points", 2);
    a.ballot(0, { 1: 100 });
    expect(b.reveal().rows.every((r) => r.stars === 0)).toBe(true);
  });
});

describe("merging and exporting", () => {
  it("only merges options that already have votes in a dot poll", () => {
    const p = poll("points", 3);
    p.ballot(0, { 1: 100 });
    expect(code(() => mergeIdeas(p.db, p.sid, 1, 2))).toBe("bad_state");
    expect(() => mergeIdeas(p.db, p.sid, 2, 3)).not.toThrow(); // neither has votes
  });
  it("labels the score column for each method in the CSV", () => {
    const labels: Record<Method, string> = { dots: "Votes", points: "Points", rank: "Borda points", score: "Average score" };
    for (const method of ["dots", "points", "rank", "score"] as const) {
      const p = poll(method, 2);
      const header = resultsToCsv(p.reveal()).replace("﻿", "").split("\r\n")[0];
      expect(header).toBe(`Rank,Tied,Code,Option,Group,Tag,${labels[method]}${method === "score" ? ",Ratings" : ""}`);
    }
  });
  it("still neutralises spreadsheet formulas in option titles for every method", () => {
    const p = poll("points", 1);
    createIdea(p.db, p.sid, { columnId: listColumns(p.db, p.sid)[0].id, title: "=HYPERLINK(\"x\")" });
    expect(resultsToCsv(p.reveal())).toContain("'=HYPERLINK");
  });
});

describe("over HTTP", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  let db: DB;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const boot = async () => {
    db = openDb(":memory:");
    app = buildApp(db);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    return call;
  };

  it("runs a rank poll end to end, and shows each person only their own ballot", async () => {
    const call = await boot();
    const made = (await call("POST", "/api/sessions", {}, { title: "Rank me", method: "rank" })).body;
    const admin = { "x-admin-key": made.adminKey };
    const bucket = (await call("GET", `/api/s/${made.id}/board`)).body.columns.find((c: any) => c.kind === "group").id;
    const ids: number[] = [];
    for (const title of ["One", "Two", "Three"]) ids.push((await call("POST", `/api/s/${made.id}/admin/ideas`, admin, { columnId: bucket, title })).body.idea.id);
    const ann = (await call("POST", `/api/s/${made.id}/join`, {}, { name: "Ann" })).body.token;
    const ben = (await call("POST", `/api/s/${made.id}/join`, {}, { name: "Ben" })).body.token;
    await call("POST", `/api/s/${made.id}/admin/action`, admin, { action: "start" });

    const put = (token: string, values: unknown) => call("PUT", `/api/s/${made.id}/ballot`, { "x-participant-token": token }, { values });
    expect((await put(ann, { [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3 })).status).toBe(200);
    expect((await put(ben, { [ids[2]]: 1, [ids[0]]: 2, [ids[1]]: 3 })).status).toBe(200);
    expect((await put(ann, { [ids[0]]: 1, [ids[1]]: 1 })).status).toBe(400); // duplicate place
    // The dot-vote route is not available in a rank poll.
    expect((await call("PUT", `/api/s/${made.id}/votes/${ids[0]}`, { "x-participant-token": ann }, { starred: true })).status).toBe(409);

    const board = (await call("GET", `/api/s/${made.id}/board`, { "x-participant-token": ann })).body;
    expect(board.settings.method).toBe("rank");
    expect(board.limits).toEqual({ rankSlots: 3, scoreMax: 5, pointsTotal: 100 });
    expect(board.me.ballot).toEqual({ [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3 });
    const text = JSON.stringify(board);
    expect(text).not.toContain("Ben");
    expect(text).not.toMatch(/"rows"|"totals"|"stars"/);

    // Results stay locked away from participants and from the organizer until the reveal.
    expect((await call("GET", `/api/s/${made.id}/admin/results`, admin)).status).toBe(409);
    expect((await call("GET", `/api/s/${made.id}/admin/results`, { "x-participant-token": ann })).status).toBe(401);
    await call("POST", `/api/s/${made.id}/admin/action`, admin, { action: "lock" });
    expect((await put(ann, { [ids[2]]: 1 })).status).toBe(403);
    await call("POST", `/api/s/${made.id}/admin/action`, admin, { action: "reveal" });
    const results = (await call("GET", `/api/s/${made.id}/admin/results`, admin)).body;
    expect(results.method).toBe("rank");
    expect(results.rows.map((r: any) => [r.title, r.stars])).toEqual([["One", 5], ["Three", 4], ["Two", 3]]);
  });
});
