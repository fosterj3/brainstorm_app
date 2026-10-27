import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./index";
import { openDb } from "./db";
import { getResults } from "./results";
import { applyAction, getSettings, reconcile, updateSettings } from "./session";
import { createSession } from "./sessions";
import { newBoard } from "./testutil";
import { VoteError, clearResponses, getCounts, getParticipant, join, listPeople, removalAllowed, removeParticipant, setSubmitted, setVote } from "./votes";

/**
 * Organizers often send a poll to a few people to test it first. These cover removing one person's votes or clearing
 * every response, and the privacy rule that goes with it: in an anonymous poll, removing someone after the results
 * were shown would reveal exactly what they picked.
 */
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

/** A live poll with voting open and three people who each voted. */
function votingPoll(extra: { named?: boolean } = {}) {
  const b = newBoard(4);
  if (extra.named) updateSettings(b.db, b.sid, { namedResults: true });
  applyAction(b.db, b.sid, "start", 1);
  const people = Object.fromEntries(["Ann", "Ben", "Cy"].map((n) => [n, join(b.db, b.sid, n).token]));
  setVote(b.db, b.sid, people.Ann, b.ideas[0].id, true);
  setVote(b.db, b.sid, people.Ben, b.ideas[0].id, true);
  setVote(b.db, b.sid, people.Ben, b.ideas[1].id, true);
  setVote(b.db, b.sid, people.Cy, b.ideas[2].id, true);
  return { ...b, people };
}
const reveal = (b: { db: Parameters<typeof applyAction>[0]; sid: string }) => {
  applyAction(b.db, b.sid, "lock", 2);
  applyAction(b.db, b.sid, "reveal", 3);
};
const starsOf = (b: ReturnType<typeof votingPoll>) => Object.fromEntries(getResults(b.db, b.sid).rows.map((r) => [r.title, r.stars]));

describe("removing one person", () => {
  it("removes them and all their votes, and leaves everyone else alone", () => {
    const b = votingPoll();
    removeParticipant(b.db, b.sid, "Ben");
    expect(getParticipant(b.db, b.sid, b.people.Ben)).toBeNull();
    expect(listPeople(b.db, b.sid).map((p) => p.name)).toEqual(["Ann", "Cy"]);
    reveal(b);
    expect(starsOf(b)).toMatchObject({ "Idea 1": 1, "Idea 2": 0, "Idea 3": 1, "Idea 4": 0 });
  });
  it("finds the person by name whatever the capitals or spacing, and frees the name", () => {
    const b = votingPoll();
    removeParticipant(b.db, b.sid, "  bEn ");
    expect(code(() => join(b.db, b.sid, "Ben"))).toBeNull();
  });
  it("rejects a name that is not in this poll, including someone from another poll", () => {
    const b = votingPoll();
    const other = votingPoll();
    expect(code(() => removeParticipant(b.db, b.sid, "Nobody"))).toBe("unknown_participant");
    // same database, different poll: Ann there must not be reachable from here
    const second = createSession(b.db, { title: "Another" }, 0);
    join(b.db, second.id, "Zed");
    expect(code(() => removeParticipant(b.db, b.sid, "Zed"))).toBe("unknown_participant");
    expect(listPeople(b.db, second.id).map((p) => p.name)).toEqual(["Zed"]);
    expect(listPeople(other.db, other.sid)).toHaveLength(3);
  });
  it("lists names and whether they submitted, and never a token or a pick", () => {
    const b = votingPoll();
    setSubmitted(b.db, b.sid, b.people.Ann, true);
    const list = listPeople(b.db, b.sid);
    expect(list.map((p) => [p.name, p.submitted])).toEqual([["Ann", true], ["Ben", false], ["Cy", false]]);
    expect(Object.keys(list[0]).sort()).toEqual(["device", "joinedAt", "name", "sameNetwork", "similarNames", "submitted", "submittedAt", "tookMs"]);
    expect(JSON.stringify(list)).not.toContain(b.people.Ann);
  });
  it("updates the headcounts", () => {
    const b = votingPoll();
    setSubmitted(b.db, b.sid, b.people.Ann, true);
    removeParticipant(b.db, b.sid, "Ann");
    expect(getCounts(b.db, b.sid)).toEqual({ joined: 2, submitted: 0 });
  });
});

describe("the privacy rule for anonymous results", () => {
  it("allows removing a person until results have been shown, then refuses", () => {
    const b = votingPoll();
    expect(removalAllowed(b.db, b.sid).allowed).toBe(true);
    reveal(b);
    expect(removalAllowed(b.db, b.sid).allowed).toBe(false);
    expect(code(() => removeParticipant(b.db, b.sid, "Ann"))).toBe("bad_state");
    expect(listPeople(b.db, b.sid)).toHaveLength(3);
  });
  it("still refuses after the results are hidden again and voting reopens", () => {
    const b = votingPoll();
    reveal(b);
    applyAction(b.db, b.sid, "hide", 4);
    applyAction(b.db, b.sid, "reopen", 5);
    expect(getSettings(b.db, b.sid).phase).toBe("voting");
    expect(code(() => removeParticipant(b.db, b.sid, "Ann"))).toBe("bad_state");
  });
  it("applies to an open poll that closed at its deadline", () => {
    const db = openDb(":memory:");
    const made = createSession(db, { title: "Open", mode: "poll", deadline: 10_000, options: ["A", "B"] }, 0);
    join(db, made.id, "Ann");
    expect(removalAllowed(db, made.id).allowed).toBe(true);
    reconcile(db, made.id, 10_001);
    expect(getSettings(db, made.id).phase).toBe("revealed");
    expect(removalAllowed(db, made.id).allowed).toBe(false);
  });
  it("does not apply when results show names", () => {
    const b = votingPoll({ named: true });
    reveal(b);
    expect(removalAllowed(b.db, b.sid).allowed).toBe(true);
    removeParticipant(b.db, b.sid, "Ben");
    expect(starsOf(b)).toMatchObject({ "Idea 1": 1, "Idea 2": 0 });
  });
  it("is lifted again once every response has been cleared", () => {
    const b = votingPoll();
    reveal(b);
    clearResponses(b.db, b.sid);
    expect(removalAllowed(b.db, b.sid).allowed).toBe(true);
  });
});

describe("clearing every response", () => {
  it("removes all people and votes but keeps the options, settings and phase", () => {
    const b = votingPoll();
    const before = getSettings(b.db, b.sid);
    expect(clearResponses(b.db, b.sid)).toBe(3);
    expect(listPeople(b.db, b.sid)).toEqual([]);
    expect((b.db.prepare("SELECT COUNT(*) AS n FROM votes").get() as { n: number }).n).toBe(0);
    expect(getSettings(b.db, b.sid)).toEqual(before);
    expect((b.db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(b.sid) as { n: number }).n).toBe(4);
    for (const t of Object.values(b.people)) expect(getParticipant(b.db, b.sid, t)).toBeNull();
  });
  it("lets people join again, with the same names, and vote on the same poll", () => {
    const b = votingPoll();
    clearResponses(b.db, b.sid);
    const ann = join(b.db, b.sid, "Ann").token;
    expect(setVote(b.db, b.sid, ann, b.ideas[3].id, true)).toEqual([b.ideas[3].id]);
    reveal(b);
    expect(starsOf(b)).toMatchObject({ "Idea 1": 0, "Idea 4": 1 });
  });
  it("shows empty results when cleared after the reveal, and leaves the poll revealed", () => {
    const b = votingPoll();
    reveal(b);
    clearResponses(b.db, b.sid);
    expect(getSettings(b.db, b.sid).phase).toBe("revealed");
    expect(Object.values(starsOf(b)).every((n) => n === 0)).toBe(true);
  });
  it("also clears votes that were restored from a CSV", () => {
    const b = votingPoll();
    b.db.prepare("UPDATE ideas SET restored_stars = 5, restored_voters = 'Old' WHERE id = ?").run(b.ideas[0].id);
    clearResponses(b.db, b.sid);
    expect(b.db.prepare("SELECT restored_stars AS s, restored_voters AS v FROM ideas WHERE id = ?").get(b.ideas[0].id)).toEqual({ s: 0, v: null });
  });
  it("only touches its own poll", () => {
    const b = votingPoll();
    const other = createSession(b.db, { title: "Other" }, 0);
    join(b.db, other.id, "Zed");
    clearResponses(b.db, b.sid);
    expect(listPeople(b.db, other.id).map((p) => p.name)).toEqual(["Zed"]);
  });
  it("is fine on a poll nobody has joined", () => {
    const b = newBoard(2);
    expect(clearResponses(b.db, b.sid)).toBe(0);
  });
});

describe("over HTTP", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  async function boot() {
    app = buildApp(openDb(":memory:"));
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
    return call;
  }
  const OPTIONS = ["A", "B", "C"];
  type Call = Awaited<ReturnType<typeof boot>>;
  const create = async (call: Call, extra: Record<string, unknown> = {}) => {
    const made = (await call("POST", "/api/sessions", {}, { title: "Test", mode: "poll", deadline: Date.now() + 3_600_000, options: OPTIONS, ...extra })).body;
    return { sid: made.id as string, admin: { "x-admin-key": made.adminKey as string } };
  };
  const joinAs = async (call: Call, sid: string, name: string) => {
    const token = (await call("POST", `/api/s/${sid}/join`, {}, { name })).body.token as string;
    return { "x-participant-token": token };
  };

  it("needs the organizer key, and one poll's key cannot touch another poll", async () => {
    const call = await boot();
    const a = await create(call);
    const b = await create(call);
    await joinAs(call, a.sid, "Ann");
    for (const [method, path, body] of [
      ["GET", `/api/s/${a.sid}/admin/people`, undefined],
      ["POST", `/api/s/${a.sid}/admin/people/remove`, { name: "Ann" }],
      ["POST", `/api/s/${a.sid}/admin/responses/clear`, undefined],
    ] as const) {
      expect((await call(method, path, {}, body)).status).toBe(401);
      expect((await call(method, path, { "x-admin-key": "wrong" }, body)).status).toBe(401);
      expect((await call(method, path, b.admin, body)).status).toBe(401);
    }
    expect((await call("GET", `/api/s/${a.sid}/admin/people`, a.admin)).body.people).toHaveLength(1);
  });

  it("shows only details about people, never tokens or picks", async () => {
    const call = await boot();
    const { sid, admin } = await create(call);
    const ann = await joinAs(call, sid, "Ann");
    const ideaId = (await call("GET", `/api/s/${sid}/board`, ann)).body.ideas[0].id;
    await call("PUT", `/api/s/${sid}/votes/${ideaId}`, ann, { starred: true });
    const r = (await call("GET", `/api/s/${sid}/admin/people`, admin)).body;
    expect(r).toMatchObject({ people: [{ name: "Ann", submitted: false }], allowed: true, reason: "" });
    expect(JSON.stringify(r)).not.toContain(ann["x-participant-token"]);
  });

  it("sends a removed person back to the join screen, and they can rejoin and vote", async () => {
    const call = await boot();
    const { sid, admin } = await create(call);
    const ann = await joinAs(call, sid, "Ann");
    const ideaId = (await call("GET", `/api/s/${sid}/board`, ann)).body.ideas[0].id;
    await call("PUT", `/api/s/${sid}/votes/${ideaId}`, ann, { starred: true });

    expect((await call("POST", `/api/s/${sid}/admin/people/remove`, admin, { name: "Ann" })).status).toBe(200);
    expect((await call("GET", `/api/s/${sid}/board`, ann)).body.me).toBeNull();
    expect((await call("PUT", `/api/s/${sid}/votes/${ideaId}`, ann, { starred: true })).status).toBe(401);

    const again = (await call("POST", `/api/s/${sid}/join`, ann, { name: "Ann" })).body; // old token is stale, name is free
    expect(again.token).not.toBe(ann["x-participant-token"]);
    expect((await call("PUT", `/api/s/${sid}/votes/${ideaId}`, { "x-participant-token": again.token }, { starred: true })).status).toBe(200);
  });

  it("refuses to remove one person from an anonymous poll after it closed, but clearing all still works", async () => {
    const call = await boot();
    const { sid, admin } = await create(call);
    const ann = await joinAs(call, sid, "Ann");
    await joinAs(call, sid, "Ben");
    const ideaId = (await call("GET", `/api/s/${sid}/board`, ann)).body.ideas[0].id;
    await call("PUT", `/api/s/${sid}/votes/${ideaId}`, ann, { starred: true });
    await call("POST", `/api/s/${sid}/admin/action`, admin, { action: "close" });

    const refused = await call("POST", `/api/s/${sid}/admin/people/remove`, admin, { name: "Ann" });
    expect(refused.status).toBe(409);
    expect((await call("GET", `/api/s/${sid}/admin/people`, admin)).body).toMatchObject({ allowed: false });
    expect((await call("GET", `/api/s/${sid}/admin/people`, admin)).body.people).toHaveLength(2);

    const cleared = await call("POST", `/api/s/${sid}/admin/responses/clear`, admin);
    expect(cleared.body).toEqual({ removed: 2 });
    expect((await call("GET", `/api/s/${sid}/admin/people`, admin)).body).toMatchObject({ people: [], allowed: true });
    const results = (await call("GET", `/api/s/${sid}/admin/results`, admin)).body;
    expect(results.rows.every((row: { stars: number }) => row.stars === 0)).toBe(true);
  });

  it("allows removing one person from a poll whose results show names", async () => {
    const call = await boot();
    const { sid, admin } = await create(call, { settings: { namedResults: true } });
    await joinAs(call, sid, "Ann");
    await call("POST", `/api/s/${sid}/admin/action`, admin, { action: "close" });
    expect((await call("POST", `/api/s/${sid}/admin/people/remove`, admin, { name: "Ann" })).status).toBe(200);
  });
});
