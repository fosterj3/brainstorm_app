import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./index";
import { openDb } from "./db";
import { insertIdeas } from "./votes";

type App = ReturnType<typeof buildApp>;
let app: App;
let base: string;
const sockets: WebSocket[] = [];
const PASS = "test-passcode";

async function boot(passcode: string | null = PASS) {
  const db = openDb(":memory:");
  insertIdeas(db, [{ title: "One" }, { title: "Two" }]);
  app = buildApp(db, { passcode: passcode ?? undefined });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

beforeEach(() => boot());

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await app.close();
});

async function api(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`http://${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const as = (token: string) => ({ "x-participant-token": token });
const asFac = (token: string) => ({ "x-facilitator-token": token });

async function join(name: string) {
  return (await api("POST", "/api/join", {}, { name })).body.token as string;
}
async function facilitator() {
  return (await api("POST", "/api/facilitator/login", {}, { passcode: PASS })).body.token as string;
}
const act = (f: string, action: string, seconds?: number) => api("POST", "/api/facilitator/action", asFac(f), { action, seconds });

async function connect(query: string) {
  const ws = new WebSocket(`ws://${base}/ws?${query}`);
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe("real-time sync", () => {
  it("rejects sockets without a valid participant or facilitator token", async () => {
    for (const q of ["token=bogus", "facilitator=bogus", ""]) {
      const ws = new WebSocket(`ws://${base}/ws?${q}`);
      const result = await new Promise((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", () => resolve("rejected"));
      });
      expect(result).toBe("rejected");
    }
  });

  it("pushes a new idea to every connected participant", async () => {
    const [a, b] = [await join("Alex"), await join("Sam")];
    const [ca, cb] = [await connect(`token=${a}`), await connect(`token=${b}`)];
    const res = await api("POST", "/api/ideas", as(a), { title: "Fresh idea" });
    expect(res.status).toBe(200);
    await settle();
    for (const c of [ca, cb]) {
      const msg = c.messages.find((m) => m.type === "ideas");
      expect(msg.ideas.map((i: any) => i.title)).toContain("Fresh idea");
    }
  });

  it("keeps votes private: only the voter's own sockets hear about them", async () => {
    const [a, b, f] = [await join("Alex"), await join("Sam"), await facilitator()];
    await act(f, "start");
    const [ca1, ca2, cb, cf] = [await connect(`token=${a}`), await connect(`token=${a}`), await connect(`token=${b}`), await connect(`facilitator=${f}`)];
    await settle();
    ca1.messages.length = ca2.messages.length = cb.messages.length = cf.messages.length = 0;
    await api("PUT", "/api/votes/1", as(a), { starred: true });
    await settle();
    expect(ca1.messages.find((m) => m.type === "votes").votes).toEqual([1]);
    expect(ca2.messages.find((m) => m.type === "votes").votes).toEqual([1]);
    expect(cb.messages).toEqual([]);
    expect(JSON.stringify(cf.messages)).not.toContain('"votes"');
  });

  it("restores votes after a disconnect and reconnect", async () => {
    const [a, f] = [await join("Alex"), await facilitator()];
    await act(f, "start");
    const first = await connect(`token=${a}`);
    await api("PUT", "/api/votes/1", as(a), { starred: true });
    await api("PUT", "/api/votes/2", as(a), { starred: true });
    first.ws.terminate();
    await settle();
    await connect(`token=${a}`);
    const session = (await api("GET", "/api/session", as(a))).body;
    expect(session.me.votes).toEqual([1, 2]);
  });

  it("serves the idea list to others without author information", async () => {
    const a = await join("Alex");
    await api("POST", "/api/ideas", as(a), { title: "Mine" });
    const b = await join("Sam");
    const session = (await api("GET", "/api/session", as(b))).body;
    expect(JSON.stringify(session)).not.toContain(a);
    expect(JSON.stringify(session)).not.toContain("Alex");
  });
});

describe("facilitator access", () => {
  it("is protected by the passcode", async () => {
    expect((await api("GET", "/api/facilitator/state")).status).toBe(401);
    expect((await api("GET", "/api/facilitator/state", asFac("1.forged"))).status).toBe(401);
    expect((await api("POST", "/api/facilitator/login", {}, { passcode: "wrong" })).status).toBe(401);
    const f = await facilitator();
    expect((await api("GET", "/api/facilitator/state", asFac(f))).status).toBe(200);
    expect((await api("POST", "/api/facilitator/action", as(await join("Alex")), { action: "start" })).status).toBe(401);
  });

  it("throttles repeated wrong passcodes", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await api("POST", "/api/facilitator/login", {}, { passcode: "nope" })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("is disabled when no passcode is configured", async () => {
    await app.close();
    await boot(null);
    expect((await api("POST", "/api/facilitator/login", {}, { passcode: "" })).status).toBe(503);
  });

  it("shows only headcounts, never what anyone picked", async () => {
    const [a, b, f] = [await join("Alex"), await join("Sam"), await facilitator()];
    await act(f, "start");
    await api("PUT", "/api/votes/1", as(a), { starred: true });
    await api("PUT", "/api/submitted", as(a), { submitted: true });
    const state = (await api("GET", "/api/facilitator/state", asFac(f))).body;
    expect(state.counts).toMatchObject({ joined: 2, submitted: 1 });
    expect(JSON.stringify(state)).not.toContain(b);
    expect(JSON.stringify(state)).not.toContain('"votes"');
    expect(JSON.stringify(state)).not.toContain('"starCount"');
  });

  it("pushes live headcounts to the facilitator as people join and submit", async () => {
    const f = await facilitator();
    await act(f, "start");
    const cf = await connect(`facilitator=${f}`);
    const a = await join("Alex");
    await api("PUT", "/api/votes/1", as(a), { starred: true });
    await api("PUT", "/api/submitted", as(a), { submitted: true });
    await settle();
    const last = cf.messages.filter((m) => m.type === "counts").at(-1);
    expect(last).toMatchObject({ joined: 1, submitted: 1 });
  });
});

describe("facilitator controls end to end", () => {
  it("runs setup, timed voting, extend, lock and reopen, pushing each change to participants", async () => {
    const [f, a] = [await facilitator(), await join("Alex")];
    const ca = await connect(`token=${a}`);

    expect((await api("PUT", "/api/votes/1", as(a), { starred: true })).status).toBe(403); // not started
    expect((await api("PUT", "/api/facilitator/settings", asFac(f), { votesPerPerson: 2, timerSeconds: 300 })).status).toBe(200);
    expect((await act(f, "start")).status).toBe(200);
    await settle();
    expect(ca.messages.some((m) => m.type === "refresh")).toBe(true);

    const s = (await api("GET", "/api/session", as(a))).body;
    expect(s.settings).toMatchObject({ phase: "voting", votesPerPerson: 2 });
    expect(s.settings.timer).toMatchObject({ state: "running", durationSec: 300 });
    expect(typeof s.serverNow).toBe("number");

    expect((await api("PUT", "/api/votes/1", as(a), { starred: true })).status).toBe(200);
    expect((await act(f, "extend", 60)).status).toBe(200);
    expect((await act(f, "lock")).status).toBe(200);
    expect((await api("PUT", "/api/votes/2", as(a), { starred: true })).status).toBe(403);
    expect((await act(f, "reopen")).status).toBe(200);
    expect((await api("PUT", "/api/votes/2", as(a), { starred: true })).status).toBe(200);
  });

  it("supports no timer at all", async () => {
    const [f, a] = [await facilitator(), await join("Alex")];
    await act(f, "start");
    const s = (await api("GET", "/api/session", as(a))).body;
    expect(s.settings.timer).toMatchObject({ durationSec: null, state: "stopped" });
    expect((await api("PUT", "/api/votes/1", as(a), { starred: true })).status).toBe(200);
  });

  it("auto-locks and tells participants when the timer runs out", async () => {
    await app.close();
    const db = openDb(":memory:");
    insertIdeas(db, [{ title: "One" }]);
    app = buildApp(db, { passcode: PASS });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const [f, a] = [await facilitator(), await join("Alex")];
    await api("PUT", "/api/facilitator/settings", asFac(f), { timerSeconds: 10, autoLock: true });
    // Shorten to ~1s directly so the test does not wait ten seconds.
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'timer_duration_sec'").run();
    const ca = await connect(`token=${a}`);
    await act(f, "start");
    await new Promise((r) => setTimeout(r, 1400));
    expect(ca.messages.filter((m) => m.type === "refresh").length).toBeGreaterThan(1);
    const s = (await api("GET", "/api/session", as(a))).body;
    expect(s.settings).toMatchObject({ phase: "locked" });
    expect(s.settings.timer.state).toBe("ended");
  });

  it("imports ideas from CSV and lets the facilitator merge and delete", async () => {
    const f = await facilitator();
    const csv = 'title,description,theme\n"Alpha, beta","First",People\nGamma,,People\n';
    const res = await api("POST", "/api/facilitator/import", asFac(f), { format: "csv", content: csv, mode: "replace" });
    expect(res.body).toEqual({ added: 2, skipped: 0 });
    const ideas = (await api("GET", "/api/facilitator/state", asFac(f))).body.ideas;
    expect(ideas.map((i: any) => i.title)).toEqual(["Alpha, beta", "Gamma"]);
    expect((await api("POST", "/api/facilitator/ideas/merge", asFac(f), { from: ideas[0].id, into: ideas[1].id })).status).toBe(200);
    expect((await api("DELETE", `/api/facilitator/ideas/${ideas[1].id}`, asFac(f))).status).toBe(200);
    expect((await api("GET", "/api/facilitator/state", asFac(f))).body.ideas).toEqual([]);
  });
});
