import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./index";
import type { DB } from "./db";
import { openDb } from "./db";
import { listColumns, listIdeas } from "./ideas";
import { getResults } from "./results";
import { applyAction, getSettings, reconcile, setSetting, updateSettings } from "./session";
import { createSession, getSummary, sessionsWithDeadline } from "./sessions";
import { VoteError, addIdea, getVotes, join, setBallot, setVote } from "./votes";

const T0 = 1_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

const OPTIONS = ["Lakeside lodge", "City hotel", "Mountain retreat"];

/** An open poll closing one hour after T0, created at T0. */
function openPoll(extra: Record<string, unknown> = {}, db: DB = openDb(":memory:")) {
  const made = createSession(db, { title: "Where to meet?", mode: "poll", deadline: T0 + HOUR, options: OPTIONS, ...extra }, T0);
  return { db, ...made };
}

describe("creating an open poll", () => {
  it("opens for votes straight away, with its deadline, method and options stored", () => {
    const { db, id } = openPoll({ method: "score" });
    expect(getSettings(db, id)).toMatchObject({ mode: "poll", phase: "voting", method: "score", deadline: T0 + HOUR, ideasOpen: false, shareResults: false });
    expect(listIdeas(db, id).map((i) => i.title)).toEqual(OPTIONS);
  });
  it("accepts groups, tags, codes, details and the other settings in one go", () => {
    const { db, id } = openPoll({
      groups: [{ name: "Venues", color: "#112233", description: "Places" }],
      options: [{ title: "Lodge", group: "Venues", tag: "Quiet", code: "V1", summary: "s", details: "d" }, "Plain"],
      settings: { votesPerPerson: 5, namedResults: true, shareResults: true },
    });
    const ideas = listIdeas(db, id);
    const venues = listColumns(db, id).find((c) => c.name === "Venues")!;
    expect(ideas[0]).toMatchObject({ title: "Lodge", columnId: venues.id, audience: "Quiet", code: "V1", summary: "s", details: "d" });
    expect(ideas[1].columnId).toBe(listColumns(db, id).find((c) => c.kind === "group")!.id);
    expect(venues).toMatchObject({ color: "#112233", description: "Places" });
    expect(getSettings(db, id)).toMatchObject({ votesPerPerson: 5, namedResults: true, shareResults: true });
  });
  it("works without a deadline, and ignores a live-only timer", () => {
    const { db, id } = openPoll({ deadline: undefined, settings: { timerSeconds: 600 } });
    expect(getSettings(db, id)).toMatchObject({ phase: "voting", deadline: null });
    expect(getSettings(db, id).timer.durationSec).toBeNull();
  });
  it("needs two options, a real mode, a future deadline within a year, and a known method", () => {
    const db = openDb(":memory:");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const bad = (extra: Record<string, unknown>) => code(() => createSession(db, { title: "P", mode: "poll", options: OPTIONS, ...extra }, T0));
    expect(bad({ options: ["Only one"] })).toBe("bad_input");
    expect(bad({ options: [] })).toBe("bad_input");
    expect(bad({ mode: "weekly" })).toBe("bad_input");
    expect(bad({ deadline: T0 - 1 })).toBe("bad_input");
    expect(bad({ deadline: T0 })).toBe("bad_input");
    expect(bad({ deadline: T0 + 400 * DAY })).toBe("bad_input");
    expect(bad({ deadline: "soon" })).toBe("bad_input");
    expect(bad({ method: "borda" })).toBe("bad_input");
    expect(bad({ settings: { votesPerPerson: 99 } })).toBe("bad_input");
    // Nothing half-made is left behind.
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(before);
  });
  it("leaves live sessions exactly as before: set up first, no deadline, participants may add options", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "Live" }, T0);
    expect(getSettings(db, id)).toMatchObject({ mode: "live", phase: "setup", deadline: null, ideasOpen: true });
    const withDeadline = createSession(db, { title: "Live too", deadline: T0 + HOUR }, T0);
    expect(getSettings(db, withDeadline.id).deadline).toBeNull(); // a deadline means nothing in a live session
  });
  it("keeps participants from adding options to an open poll", () => {
    const { db, id } = openPoll();
    const token = join(db, id, "Ann").token;
    expect(code(() => addIdea(db, id, token, { title: "Sneaky" }, T0 + 1))).toBe("ideas_closed");
  });
  it("shows in the organizer's list with its mode and deadline", () => {
    const { db, id } = openPoll();
    expect(getSummary(db, id)).toMatchObject({ mode: "poll", phase: "voting", deadline: T0 + HOUR });
    expect(sessionsWithDeadline(db)).toEqual([id]);
  });
});

describe("closing at the deadline", () => {
  it("accepts votes until the deadline, then closes and reveals results to the organizer", () => {
    const { db, id } = openPoll({ method: "dots" });
    const ann = join(db, id, "Ann").token;
    expect(reconcile(db, id, T0 + HOUR - 1)).toBe(false);
    expect(() => setVote(db, id, ann, 1, true, T0 + HOUR - 1)).not.toThrow();
    expect(getSettings(db, id).phase).toBe("voting");
    expect(() => getResults(db, id)).toThrow(VoteError); // hidden while open

    expect(reconcile(db, id, T0 + HOUR)).toBe(true);
    expect(getSettings(db, id).phase).toBe("revealed");
    expect(getResults(db, id).rows[0]).toMatchObject({ title: "Lakeside lodge", stars: 1 });
  });
  it("rejects votes from the moment of the deadline, even before anyone has looked at the poll", () => {
    const { db, id } = openPoll();
    const ann = join(db, id, "Ann").token;
    // No reconcile call first: voting itself checks the stored deadline.
    expect(() => setVote(db, id, ann, 1, true, T0 + HOUR - 1)).not.toThrow();
    expect(code(() => setVote(db, id, ann, 2, true, T0 + HOUR))).toBe("locked");
    expect(getVotes(db, id, ann)).toEqual([1]);
    expect(getSettings(db, id).phase).toBe("revealed");
  });
  it("works for every voting method", () => {
    for (const method of ["rank", "score", "points"] as const) {
      const { db, id } = openPoll({ method });
      const ann = join(db, id, "Ann").token;
      const ballot = method === "rank" ? { 1: 1, 2: 2, 3: 3 } : method === "score" ? { 1: 5 } : { 1: 100 };
      setBallot(db, id, ann, ballot, T0 + 10);
      expect(code(() => setBallot(db, id, ann, ballot, T0 + HOUR))).toBe("locked");
      expect(getResults(db, id).rows[0].title).toBe("Lakeside lodge");
    }
  });
  it("uses the stored time, so it survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ority-open-"));
    try {
      const file = path.join(dir, "open.db");
      const first = openDb(file);
      const { id } = openPoll({}, first);
      const ann = join(first, id, "Ann").token;
      setVote(first, id, ann, 1, true, T0 + 5);
      first.close();

      const second = openDb(file); // a fresh process knows nothing but what is stored
      expect(getSettings(second, id)).toMatchObject({ phase: "voting", deadline: T0 + HOUR });
      expect(sessionsWithDeadline(second)).toEqual([id]);
      expect(reconcile(second, id, T0 + 2 * HOUR)).toBe(true);
      expect(getSettings(second, id).phase).toBe("revealed");
      expect(getResults(second, id).rows[0].stars).toBe(1);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("never closes a poll that has no deadline, or a live session", () => {
    const none = openPoll({ deadline: undefined });
    reconcile(none.db, none.id, T0 + 400 * DAY);
    expect(getSettings(none.db, none.id).phase).toBe("voting");
    const live = openDb(":memory:");
    const { id } = createSession(live, { title: "Live" }, T0);
    setSetting(live, id, "deadline", T0 + 1);
    applyAction(live, id, "start", T0);
    reconcile(live, id, T0 + HOUR);
    expect(getSettings(live, id).phase).toBe("voting");
  });
});

describe("organizer controls for an open poll", () => {
  it("can close now, which reveals the results, and reopen with a new deadline", () => {
    const { db, id } = openPoll();
    const ann = join(db, id, "Ann").token;
    setVote(db, id, ann, 1, true, T0 + 10);
    applyAction(db, id, "close", T0 + 20);
    expect(getSettings(db, id).phase).toBe("revealed");
    expect(code(() => setVote(db, id, ann, 2, true, T0 + 30))).toBe("locked");

    applyAction(db, id, "reopen", T0 + 40, undefined, { deadline: T0 + 5 * HOUR });
    expect(getSettings(db, id)).toMatchObject({ phase: "voting", deadline: T0 + 5 * HOUR });
    expect(code(() => getResults(db, id))).toBe("bad_state"); // hidden again
    expect(() => setVote(db, id, ann, 2, true, T0 + 50)).not.toThrow();
    expect(getVotes(db, id, ann)).toEqual([1, 2]);
  });
  it("reopens without an old deadline that would close it again at once", () => {
    const { db, id } = openPoll();
    reconcile(db, id, T0 + 2 * HOUR);
    applyAction(db, id, "reopen", T0 + 2 * HOUR);
    expect(getSettings(db, id)).toMatchObject({ phase: "voting", deadline: null });
    expect(reconcile(db, id, T0 + 400 * DAY)).toBe(false);
  });
  it("refuses a reopen deadline in the past, and close or reopen at the wrong time", () => {
    const { db, id } = openPoll();
    expect(code(() => applyAction(db, id, "reopen", T0 + 10))).toBe("bad_state"); // still open
    applyAction(db, id, "close", T0 + 20);
    expect(code(() => applyAction(db, id, "close", T0 + 30))).toBe("bad_state"); // already closed
    expect(code(() => applyAction(db, id, "reopen", T0 + 40, undefined, { deadline: T0 }))).toBe("bad_input");
    expect(getSettings(db, id).phase).toBe("revealed");
  });
  it("does not offer close in a live session", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "Live", options: OPTIONS }, T0);
    applyAction(db, id, "start", T0);
    expect(code(() => applyAction(db, id, "close", T0))).toBe("bad_state");
  });
  it("can change the deadline while open, with the same checks as when creating", () => {
    const { db, id } = openPoll();
    updateSettings(db, id, { deadline: T0 + 2 * DAY }, T0 + 10);
    expect(getSettings(db, id).deadline).toBe(T0 + 2 * DAY);
    updateSettings(db, id, { deadline: null }, T0 + 10);
    expect(getSettings(db, id).deadline).toBeNull();
    expect(code(() => updateSettings(db, id, { deadline: T0 }, T0 + 10))).toBe("bad_input");
    expect(code(() => updateSettings(db, id, { deadline: T0 + 800 * DAY }, T0 + 10))).toBe("bad_input");
    reconcile(db, id, T0 + 3 * DAY);
    updateSettings(db, id, { deadline: T0 + 5 * DAY }, T0 + 3 * DAY - 1); // still voting: fine
  });
  it("only lets live sessions skip deadlines, and only open polls share results", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "Live" }, T0);
    expect(code(() => updateSettings(db, id, { deadline: T0 + HOUR }, T0))).toBe("bad_state");
    expect(code(() => updateSettings(db, id, { shareResults: true }))).toBe("bad_state");
    const poll = openPoll();
    updateSettings(poll.db, poll.id, { shareResults: true });
    expect(getSettings(poll.db, poll.id).shareResults).toBe(true);
  });
});

describe("over HTTP with a controllable clock", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  async function boot() {
    let clock = T0;
    const db = openDb(":memory:");
    app = buildApp(db, { now: () => clock });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const call = async (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { call, advance: (ms: number) => { clock += ms; }, db };
  }
  const create = async (call: Awaited<ReturnType<typeof boot>>["call"], extra: Record<string, unknown> = {}) => {
    const made = (await call("POST", "/api/sessions", {}, { title: "Open", mode: "poll", deadline: T0 + HOUR, options: OPTIONS, ...extra })).body;
    return { sid: made.id as string, admin: { "x-admin-key": made.adminKey as string } };
  };
  const as = (token: string) => ({ "x-participant-token": token });

  it("closes by itself at the deadline, with no organizer action and no connected screens", async () => {
    const { call, advance } = await boot();
    const { sid, admin } = await create(call);
    const ann = (await call("POST", `/api/s/${sid}/join`, {}, { name: "Ann" })).body.token;
    const first = (await call("GET", `/api/s/${sid}/board`, as(ann))).body.ideas[0].id;
    expect((await call("PUT", `/api/s/${sid}/votes/${first}`, as(ann), { starred: true })).status).toBe(200);
    expect((await call("GET", `/api/s/${sid}/admin/results`, admin)).status).toBe(409); // hidden while open

    advance(HOUR);
    const board = (await call("GET", `/api/s/${sid}/board`, as(ann))).body;
    expect(board.settings).toMatchObject({ mode: "poll", phase: "revealed", deadline: T0 + HOUR });
    const late = await call("PUT", `/api/s/${sid}/votes/${first}`, as(ann), { starred: false });
    expect([late.status, late.body.message]).toEqual([403, "This poll has closed."]);
    const results = (await call("GET", `/api/s/${sid}/admin/results`, admin)).body;
    expect(results.rows[0]).toMatchObject({ title: "Lakeside lodge", stars: 1 });
  });

  it("shares anonymous results with participants only if the organizer chose to, and only after closing", async () => {
    const { call, advance } = await boot();
    const shared = await create(call, { settings: { namedResults: true, shareResults: true } });
    const hidden = await create(call);
    const tokens: Record<string, string> = {};
    for (const [key, p] of [["shared", shared], ["hidden", hidden]] as const) {
      tokens[key] = (await call("POST", `/api/s/${p.sid}/join`, {}, { name: "Ann Smith" })).body.token;
      const id = (await call("GET", `/api/s/${p.sid}/board`)).body.ideas[0].id;
      await call("PUT", `/api/s/${p.sid}/votes/${id}`, as(tokens[key]), { starred: true });
    }
    const get = (p: { sid: string }, key: string) => call("GET", `/api/s/${p.sid}/results`, as(tokens[key]));

    expect((await get(shared, "shared")).status).toBe(409); // still open
    advance(HOUR);
    const ok = await get(shared, "shared");
    expect(ok.status).toBe(200);
    expect(ok.body.named).toBe(false); // the organizer sees names, participants never do
    expect(JSON.stringify(ok.body)).not.toContain("Ann Smith");
    expect(ok.body.rows[0]).toMatchObject({ title: "Lakeside lodge", stars: 1 });
    expect((await call("GET", `/api/s/${shared.sid}/admin/results`, shared.admin)).body.rows[0].voters).toEqual(["Ann Smith"]);

    expect((await get(hidden, "hidden")).status).toBe(409); // closed, but not shared
    expect((await call("GET", `/api/s/${hidden.sid}/admin/results`, hidden.admin)).status).toBe(200);
  });

  it("needs a participant of that poll to see shared results", async () => {
    const { call, advance } = await boot();
    const a = await create(call, { settings: { shareResults: true } });
    const b = await create(call, { settings: { shareResults: true } });
    const annA = (await call("POST", `/api/s/${a.sid}/join`, {}, { name: "Ann" })).body.token;
    advance(HOUR);
    expect((await call("GET", `/api/s/${a.sid}/results`)).status).toBe(401);
    expect((await call("GET", `/api/s/${a.sid}/results`, as("made-up"))).status).toBe(401);
    expect((await call("GET", `/api/s/${b.sid}/results`, as(annA))).status).toBe(401); // a token from another poll
    expect((await call("GET", `/api/s/${a.sid}/results`, as(annA))).status).toBe(200);
    expect((await call("GET", `/api/s/${a.sid}/admin/results`, as(annA))).status).toBe(401); // never the organizer's route
  });

  it("is not available for live sessions, even if results are revealed", async () => {
    const { call } = await boot();
    const made = (await call("POST", "/api/sessions", {}, { title: "Live", options: OPTIONS })).body;
    const admin = { "x-admin-key": made.adminKey };
    const ann = (await call("POST", `/api/s/${made.id}/join`, {}, { name: "Ann" })).body.token;
    for (const action of ["start", "lock", "reveal"]) await call("POST", `/api/s/${made.id}/admin/action`, admin, { action });
    expect((await call("GET", `/api/s/${made.id}/results`, as(ann))).status).toBe(409);
  });

  it("lets the organizer close now and reopen over the API", async () => {
    const { call, advance } = await boot();
    const { sid, admin } = await create(call);
    expect((await call("POST", `/api/s/${sid}/admin/action`, admin, { action: "close" })).status).toBe(200);
    expect((await call("GET", `/api/s/${sid}/admin/results`, admin)).status).toBe(200);
    expect((await call("POST", `/api/s/${sid}/admin/action`, admin, { action: "reopen", deadline: T0 + 3 * HOUR })).status).toBe(200);
    expect((await call("GET", `/api/s/${sid}/admin/results`, admin)).status).toBe(409);
    expect((await call("PUT", `/api/s/${sid}/admin/settings`, admin, { deadline: T0 + 6 * HOUR })).status).toBe(200);
    expect((await call("PUT", `/api/s/${sid}/admin/settings`, admin, { deadline: T0 - HOUR })).status).toBe(400);
    advance(2 * HOUR);
    expect((await call("GET", `/api/s/${sid}/board`)).body.settings.phase).toBe("voting"); // the new deadline is later
    advance(5 * HOUR);
    expect((await call("GET", `/api/s/${sid}/board`)).body.settings.phase).toBe("revealed");
  });
});
