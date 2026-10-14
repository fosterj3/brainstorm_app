import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./index";
import { openDb } from "./db";

type App = ReturnType<typeof buildApp>;
let app: App;
let db: ReturnType<typeof openDb>;
let base: string;
const sockets: WebSocket[] = [];

async function boot(opts: Parameters<typeof buildApp>[1] = {}) {
  db = openDb(":memory:");
  app = buildApp(db, opts);
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
const asAdmin = (key: string) => ({ "x-admin-key": key });

/** Create a board through the public API, with one column and two ideas. */
async function makeBoard(template: "blank" | "example" = "blank") {
  const { body } = await api("POST", "/api/sessions", {}, { title: "Test board", template });
  const sid = body.id as string;
  const key = body.adminKey as string;
  let first = 0;
  if (template === "blank") {
    const col = (await api("POST", `/api/s/${sid}/admin/columns`, asAdmin(key), { name: "Alpha" })).body.column;
    first = (await api("POST", `/api/s/${sid}/admin/ideas`, asAdmin(key), { columnId: col.id, title: "One" })).body.idea.id;
    await api("POST", `/api/s/${sid}/admin/ideas`, asAdmin(key), { columnId: col.id, title: "Two" });
  }
  return { sid, key, first, second: first + 1 };
}
async function join(sid: string, name: string) {
  return (await api("POST", `/api/s/${sid}/join`, {}, { name })).body.token as string;
}
const act = (b: { sid: string; key: string }, action: string, seconds?: number) =>
  api("POST", `/api/s/${b.sid}/admin/action`, asAdmin(b.key), { action, seconds });

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

describe("creating and finding boards", () => {
  it("anyone can create a board and gets a participant code and a secret key", async () => {
    const { status, body } = await api("POST", "/api/sessions", {}, { title: "Offsite" });
    expect(status).toBe(200);
    expect(body.id).toMatch(/^[2-9a-z]{8}$/);
    expect(typeof body.adminKey).toBe("string");
    expect((await api("GET", `/api/s/${body.id}/exists`)).body.title).toBe("Offsite");
    expect((await api("GET", "/api/s/zzzzzzzz/exists")).status).toBe(404);
  });
  it("starts from the example board when asked", async () => {
    const b = await makeBoard("example");
    const board = (await api("GET", `/api/s/${b.sid}/board`)).body;
    expect(board.columns.length).toBeGreaterThan(2);
    expect(board.ideas.length).toBeGreaterThan(3);
  });
  it("limits how many boards one client can create", async () => {
    await app.close();
    await boot({ createLimit: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api("POST", "/api/sessions", {}, { title: `B${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
  it("rejects a board without a title", async () => {
    expect((await api("POST", "/api/sessions", {}, { title: "  " })).status).toBe(400);
  });
});

describe("facilitator access", () => {
  it("needs the secret key for that board, and no other board's key works", async () => {
    const [a, b] = [await makeBoard(), await makeBoard()];
    const url = (sid: string) => `/api/s/${sid}/admin/state`;
    expect((await api("GET", url(a.sid))).status).toBe(401);
    expect((await api("GET", url(a.sid), asAdmin("forged"))).status).toBe(401);
    expect((await api("GET", url(a.sid), asAdmin(b.key))).status).toBe(401);
    expect((await api("GET", url(a.sid), asAdmin(a.key))).status).toBe(200);
    expect((await api("GET", url("zzzzzzzz"), asAdmin(a.key))).status).toBe(401);
  });
  it("is closed to participants", async () => {
    const b = await makeBoard();
    const token = await join(b.sid, "Alex");
    expect((await api("POST", `/api/s/${b.sid}/admin/action`, as(token), { action: "start" })).status).toBe(401);
  });
  it("shows only headcounts, never what anyone picked", async () => {
    const b = await makeBoard();
    const [alex, sam] = [await join(b.sid, "Alex"), await join(b.sid, "Sam")];
    await act(b, "start");
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(alex), { starred: true });
    await api("PUT", `/api/s/${b.sid}/submitted`, as(alex), { submitted: true });
    const state = (await api("GET", `/api/s/${b.sid}/admin/state`, asAdmin(b.key))).body;
    expect(state.counts).toMatchObject({ joined: 2, submitted: 1 });
    expect(JSON.stringify(state)).not.toContain(sam);
    expect(JSON.stringify(state)).not.toContain('"votes"');
    expect(JSON.stringify(state)).not.toContain(alex);
  });
});

describe("boards stay separate", () => {
  it("a participant token from one board does nothing on another", async () => {
    const [a, b] = [await makeBoard(), await makeBoard()];
    const alex = await join(a.sid, "Alex");
    await act(b, "start");
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(alex))).body;
    expect(board.me).toBeNull();
    expect((await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(alex), { starred: true })).status).toBe(401);
  });
  it("one board's facilitator cannot edit another board's ideas", async () => {
    const [a, b] = [await makeBoard(), await makeBoard()];
    const res = await api("PUT", `/api/s/${a.sid}/admin/ideas/${b.first}`, asAdmin(a.key), { title: "hacked" });
    expect(res.status).toBe(404);
    const theirs = (await api("GET", `/api/s/${b.sid}/board`)).body.ideas.find((i: any) => i.id === b.first);
    expect(theirs.title).toBe("One");
  });
  it("pushes reach only the right board", async () => {
    const [a, b] = [await makeBoard(), await makeBoard()];
    const [alexA, samB] = [await join(a.sid, "Alex"), await join(b.sid, "Sam")];
    const [ca, cb] = [await connect(`session=${a.sid}&token=${alexA}`), await connect(`session=${b.sid}&token=${samB}`)];
    await settle();
    ca.messages.length = cb.messages.length = 0;
    await api("POST", `/api/s/${a.sid}/ideas`, as(alexA), { title: "Fresh idea" });
    await act(a, "start");
    await settle();
    expect(ca.messages.some((m) => m.type === "ideas")).toBe(true);
    expect(cb.messages).toEqual([]);
  });
});

describe("real-time sync", () => {
  it("rejects sockets without a valid session and participant or facilitator credentials", async () => {
    const b = await makeBoard();
    const alex = await join(b.sid, "Alex");
    for (const q of ["session=zzzzzzzz&token=bogus", `session=${b.sid}&token=bogus`, `session=${b.sid}&admin=bogus`, `token=${alex}`, ""]) {
      const ws = new WebSocket(`ws://${base}/ws?${q}`);
      const result = await new Promise((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", () => resolve("rejected"));
      });
      expect(result).toBe("rejected");
    }
  });

  it("pushes a new idea to every connected participant, into the group column", async () => {
    const b = await makeBoard();
    const [a, s] = [await join(b.sid, "Alex"), await join(b.sid, "Sam")];
    const [ca, cs] = [await connect(`session=${b.sid}&token=${a}`), await connect(`session=${b.sid}&token=${s}`)];
    const res = await api("POST", `/api/s/${b.sid}/ideas`, as(a), { title: "Fresh idea", summary: "Why" });
    expect(res.status).toBe(200);
    await settle();
    const group = (await api("GET", `/api/s/${b.sid}/board`)).body.columns.find((c: any) => c.kind === "group");
    for (const c of [ca, cs]) {
      const msg = c.messages.find((m) => m.type === "ideas");
      const idea = msg.ideas.find((i: any) => i.title === "Fresh idea");
      expect(idea.columnId).toBe(group.id);
    }
  });

  it("keeps votes private: only the voter's own sockets hear about them", async () => {
    const b = await makeBoard();
    const [a, s] = [await join(b.sid, "Alex"), await join(b.sid, "Sam")];
    await act(b, "start");
    const [ca1, ca2, cs, cf] = [
      await connect(`session=${b.sid}&token=${a}`), await connect(`session=${b.sid}&token=${a}`),
      await connect(`session=${b.sid}&token=${s}`), await connect(`session=${b.sid}&admin=${b.key}`),
    ];
    await settle();
    for (const c of [ca1, ca2, cs, cf]) c.messages.length = 0;
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(a), { starred: true });
    await settle();
    expect(ca1.messages.find((m) => m.type === "votes").votes).toEqual([b.first]);
    expect(ca2.messages.find((m) => m.type === "votes").votes).toEqual([b.first]);
    expect(cs.messages).toEqual([]);
    expect(JSON.stringify(cf.messages)).not.toContain('"votes"');
  });

  it("restores votes after a disconnect and reconnect", async () => {
    const b = await makeBoard();
    const a = await join(b.sid, "Alex");
    await act(b, "start");
    const first = await connect(`session=${b.sid}&token=${a}`);
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(a), { starred: true });
    await api("PUT", `/api/s/${b.sid}/votes/${b.second}`, as(a), { starred: true });
    first.ws.terminate();
    await settle();
    await connect(`session=${b.sid}&token=${a}`);
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(a))).body;
    expect(board.me.votes).toEqual([b.first, b.second]);
  });

  it("serves ideas to others without author information", async () => {
    const b = await makeBoard();
    const a = await join(b.sid, "Alex");
    await api("POST", `/api/s/${b.sid}/ideas`, as(a), { title: "Mine" });
    const other = await join(b.sid, "Sam");
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(other))).body;
    expect(JSON.stringify(board)).not.toContain(a);
    expect(JSON.stringify(board)).not.toContain("Alex");
  });

  it("pushes live headcounts to the facilitator as people join and submit", async () => {
    const b = await makeBoard();
    await act(b, "start");
    const cf = await connect(`session=${b.sid}&admin=${b.key}`);
    const a = await join(b.sid, "Alex");
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(a), { starred: true });
    await api("PUT", `/api/s/${b.sid}/submitted`, as(a), { submitted: true });
    await settle();
    const last = cf.messages.filter((m) => m.type === "counts").at(-1);
    expect(last).toMatchObject({ joined: 1, submitted: 1 });
  });
});

describe("facilitator controls end to end", () => {
  it("runs setup, timed voting, extend, lock and reopen, pushing each change to participants", async () => {
    const b = await makeBoard();
    const a = await join(b.sid, "Alex");
    const ca = await connect(`session=${b.sid}&token=${a}`);
    const vote = (id: number) => api("PUT", `/api/s/${b.sid}/votes/${id}`, as(a), { starred: true });

    expect((await vote(b.first)).status).toBe(403); // not started
    expect((await api("PUT", `/api/s/${b.sid}/admin/settings`, asAdmin(b.key), { votesPerPerson: 2, timerSeconds: 300 })).status).toBe(200);
    expect((await act(b, "start")).status).toBe(200);
    await settle();
    expect(ca.messages.some((m) => m.type === "refresh")).toBe(true);

    const board = (await api("GET", `/api/s/${b.sid}/board`, as(a))).body;
    expect(board.settings).toMatchObject({ phase: "voting", votesPerPerson: 2 });
    expect(board.settings.timer).toMatchObject({ state: "running", durationSec: 300 });
    expect(typeof board.serverNow).toBe("number");

    expect((await vote(b.first)).status).toBe(200);
    expect((await act(b, "extend", 60)).status).toBe(200);
    expect((await act(b, "lock")).status).toBe(200);
    expect((await vote(b.second)).status).toBe(403);
    expect((await act(b, "reopen")).status).toBe(200);
    expect((await vote(b.second)).status).toBe(200);
  });

  it("supports no timer at all", async () => {
    const b = await makeBoard();
    const a = await join(b.sid, "Alex");
    await act(b, "start");
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(a))).body;
    expect(board.settings.timer).toMatchObject({ durationSec: null, state: "stopped" });
    expect((await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(a), { starred: true })).status).toBe(200);
  });

  it("auto-locks and tells participants when the timer runs out", async () => {
    const b = await makeBoard();
    const a = await join(b.sid, "Alex");
    await api("PUT", `/api/s/${b.sid}/admin/settings`, asAdmin(b.key), { timerSeconds: 10, autoLock: true });
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'timer_duration_sec' AND session_id = ?").run(b.sid); // ~1s, so the test is quick
    const ca = await connect(`session=${b.sid}&token=${a}`);
    await act(b, "start");
    await new Promise((r) => setTimeout(r, 1400));
    expect(ca.messages.filter((m) => m.type === "refresh").length).toBeGreaterThan(1);
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(a))).body;
    expect(board.settings).toMatchObject({ phase: "locked" });
    expect(board.settings.timer.state).toBe("ended");
  });

  it("builds a board from scratch: columns, colors, ideas, reorder", async () => {
    const b = await makeBoard();
    const h = asAdmin(b.key);
    const col = (await api("POST", `/api/s/${b.sid}/admin/columns`, h, { name: "Beta", color: "#123456", description: "d" })).body.column;
    expect(col.color).toBe("#123456");
    await api("PUT", `/api/s/${b.sid}/admin/columns/${col.id}`, h, { color: "#654321" });
    await api("POST", `/api/s/${b.sid}/admin/columns/${col.id}/move`, h, { direction: "left" });
    await api("PUT", `/api/s/${b.sid}/admin/board`, h, { title: "Renamed", bg: "#fff8e1" });
    const idea = (await api("POST", `/api/s/${b.sid}/admin/ideas`, h, { columnId: col.id, title: "Card", summary: "s", details: "long", audience: "For all" })).body.idea;
    const board = (await api("GET", `/api/s/${b.sid}/board`)).body;
    expect(board.board).toMatchObject({ title: "Renamed", bg: "#fff8e1" });
    expect(board.columns.map((c: any) => c.name)).toEqual(["Beta", "Alpha", "Ideas from the group"]);
    expect(board.columns[0].color).toBe("#654321");
    expect(board.ideas.find((i: any) => i.id === idea.id)).toMatchObject({ details: "long", audience: "For all", code: "B1" });
  });

  it("imports CSV and exports the board", async () => {
    const b = await makeBoard();
    const h = asAdmin(b.key);
    const csv = 'column,title,summary\nPeople,"Alpha, beta",First\nPeople,Gamma,\n';
    const res = await api("POST", `/api/s/${b.sid}/admin/import`, h, { format: "csv", content: csv, mode: "replace" });
    expect(res.body).toEqual({ added: 2, skipped: 0, columnsAdded: 1 });
    const out = (await api("GET", `/api/s/${b.sid}/admin/export`, h)).body;
    expect(out.columns.map((c: any) => c.name)).toEqual(["People"]);
    expect(out.ideas.map((i: any) => i.title)).toEqual(["Alpha, beta", "Gamma"]);
  });
});

describe("results", () => {
  async function votedBoard() {
    const b = await makeBoard();
    const [alex, sam] = [await join(b.sid, "Alex"), await join(b.sid, "Sam")];
    await act(b, "start");
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(alex), { starred: true });
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(sam), { starred: true });
    await api("PUT", `/api/s/${b.sid}/votes/${b.second}`, as(sam), { starred: true });
    return { ...b, alex, sam };
  }
  const results = (b: { sid: string; key: string }) => api("GET", `/api/s/${b.sid}/admin/results`, asAdmin(b.key));

  it("are refused until revealed, and need the facilitator key", async () => {
    const b = await votedBoard();
    expect((await api("GET", `/api/s/${b.sid}/admin/results`)).status).toBe(401);
    expect((await api("GET", `/api/s/${b.sid}/admin/results`, as(b.alex))).status).toBe(401);
    expect((await results(b)).status).toBe(409); // still voting
    await act(b, "lock");
    expect((await results(b)).status).toBe(409); // locked but not revealed
    expect((await act(b, "reveal")).status).toBe(200);
    const r = await results(b);
    expect(r.status).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ id: b.first, stars: 2, rank: 1, tied: false });
    expect(r.body.rows[1]).toMatchObject({ id: b.second, stars: 1, rank: 2 });
  });

  it("never reach participants, before or after the reveal", async () => {
    const b = await votedBoard();
    await act(b, "lock");
    await act(b, "reveal");
    const board = (await api("GET", `/api/s/${b.sid}/board`, as(b.alex))).body;
    expect(board.settings.phase).toBe("revealed");
    const text = JSON.stringify(board);
    expect(text).not.toContain('"stars"');
    expect(text).not.toContain('"rank"');
    expect(text).not.toContain("Sam");
    expect((await api("GET", `/api/s/${b.sid}/admin/results`, as(b.alex))).status).toBe(401);
  });

  it("tell participants that results are showing, and block further votes", async () => {
    const b = await votedBoard();
    const ca = await connect(`session=${b.sid}&token=${b.alex}`);
    await settle();
    ca.messages.length = 0;
    await act(b, "lock");
    await act(b, "reveal");
    await settle();
    expect(ca.messages.filter((m) => m.type === "refresh").length).toBeGreaterThanOrEqual(2);
    expect((await api("PUT", `/api/s/${b.sid}/votes/${b.second}`, as(b.alex), { starred: true })).status).toBe(403);
  });

  it("export as CSV with the right headers, anonymous by default", async () => {
    const b = await votedBoard();
    await act(b, "lock");
    await act(b, "reveal");
    const res = await fetch(`http://${base}/api/s/${b.sid}/admin/results.csv`, { headers: asAdmin(b.key) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csv = await res.text();
    expect(csv).toContain("Rank,Tied,Code,Idea,Column,Audience,Stars");
    expect(csv).toContain(",One,Alpha,,2");
    expect(csv).not.toMatch(/Alex|Sam|Starred by/);
    expect((await fetch(`http://${base}/api/s/${b.sid}/admin/results.csv`)).status).toBe(401);
  });

  it("show who starred what only when the facilitator chose named results", async () => {
    const b = await votedBoard();
    await api("PUT", `/api/s/${b.sid}/admin/settings`, asAdmin(b.key), { namedResults: true });
    await act(b, "lock");
    await act(b, "reveal");
    const r = (await results(b)).body;
    expect(r.named).toBe(true);
    expect(r.rows[0].voters).toEqual(["Alex", "Sam"]);
    const csv = await (await fetch(`http://${base}/api/s/${b.sid}/admin/results.csv`, { headers: asAdmin(b.key) })).text();
    expect(csv).toContain("Alex; Sam");
  });

  it("can be hidden again, which closes the results", async () => {
    const b = await votedBoard();
    await act(b, "lock");
    await act(b, "reveal");
    expect((await act(b, "hide")).status).toBe(200);
    expect((await results(b)).status).toBe(409);
  });
});

describe("my boards: summary and delete over the API", () => {
  it("summary needs the facilitator key and shows headcounts", async () => {
    const b = await makeBoard();
    await join(b.sid, "Alex");
    expect((await api("GET", `/api/s/${b.sid}/admin/summary`)).status).toBe(401);
    const r = await api("GET", `/api/s/${b.sid}/admin/summary`, asAdmin(b.key));
    expect(r.body).toMatchObject({ id: b.sid, title: "Test board", phase: "setup", ideas: 2, joined: 1 });
  });

  it("delete needs the key of that board, and removes it for everyone", async () => {
    const [a, other] = [await makeBoard(), await makeBoard()];
    const alex = await join(a.sid, "Alex");
    expect((await api("DELETE", `/api/s/${a.sid}/admin`)).status).toBe(401);
    expect((await api("DELETE", `/api/s/${a.sid}/admin`, as(alex))).status).toBe(401);
    expect((await api("DELETE", `/api/s/${a.sid}/admin`, asAdmin(other.key))).status).toBe(401);
    expect((await api("GET", `/api/s/${a.sid}/board`)).status).toBe(200); // still there

    const ca = await connect(`session=${a.sid}&token=${alex}`);
    const closed = new Promise((r) => ca.ws.once("close", r));
    expect((await api("DELETE", `/api/s/${a.sid}/admin`, asAdmin(a.key))).status).toBe(200);
    await closed;
    expect(ca.messages.some((m) => m.type === "deleted")).toBe(true);

    expect((await api("GET", `/api/s/${a.sid}/board`)).status).toBe(404);
    expect((await api("GET", `/api/s/${a.sid}/exists`)).status).toBe(404);
    expect((await api("GET", `/api/s/${a.sid}/admin/state`, asAdmin(a.key))).status).toBe(401);
    expect((await api("POST", `/api/s/${a.sid}/join`, {}, { name: "Late" })).status).toBe(404);
    // the other board is untouched
    expect((await api("GET", `/api/s/${other.sid}/board`)).status).toBe(200);
    expect((await api("GET", `/api/s/${other.sid}/admin/state`, asAdmin(other.key))).status).toBe(200);
  });
});

describe("restoring results over the API", () => {
  const csv = "Rank,Tied,Code,Idea,Column,Audience,Stars\r\n1,,A1,First,Alpha,For all,3\r\n2,,A2,Second,Alpha,,1\r\n";

  it("creates a new board with the results showing, readable only with its own key", async () => {
    const res = await api("POST", "/api/sessions/restore", {}, { title: "Restored", csv });
    expect(res.status).toBe(200);
    const { id, adminKey } = res.body;
    const r = await api("GET", `/api/s/${id}/admin/results`, asAdmin(adminKey));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ restored: true, named: false });
    expect(r.body.rows.map((x: any) => [x.title, x.stars, x.rank])).toEqual([["First", 3, 1], ["Second", 1, 2]]);
    expect((await api("GET", `/api/s/${id}/admin/results`)).status).toBe(401);
    // Participants see only that results are showing, never the tally.
    const board = (await api("GET", `/api/s/${id}/board`)).body;
    expect(board.settings.phase).toBe("revealed");
    expect(JSON.stringify(board)).not.toContain('"stars"');
  });

  it("the facilitator can download the restored results again", async () => {
    const { id, adminKey } = (await api("POST", "/api/sessions/restore", {}, { title: "Restored", csv })).body;
    const out = await (await fetch(`http://${base}/api/s/${id}/admin/results.csv`, { headers: asAdmin(adminKey) })).text();
    expect(out).toContain(",First,Alpha,For all,3");
  });

  it("rejects a file that is not a results file, and creates no board", async () => {
    const bad = await api("POST", "/api/sessions/restore", {}, { title: "Nope", csv: "name,age\nAnn,3\n" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("Idea");
    expect((await api("POST", "/api/sessions/restore", {}, { title: "Nope" })).status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  });

  it("counts toward the board-creation limit", async () => {
    await app.close();
    await boot({ createLimit: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await api("POST", "/api/sessions/restore", {}, { title: `R${i}`, csv })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("making sure people submit", () => {
  async function voting() {
    const b = await makeBoard();
    const [ann, ben, cy] = [await join(b.sid, "Ann"), await join(b.sid, "Ben"), await join(b.sid, "Cy")];
    await act(b, "start");
    return { ...b, ann, ben, cy };
  }
  const state = (b: { sid: string; key: string }) => api("GET", `/api/s/${b.sid}/admin/state`, asAdmin(b.key));

  it("shows the facilitator who has not submitted, by name only", async () => {
    const b = await voting();
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(b.ann), { starred: true });
    await api("PUT", `/api/s/${b.sid}/submitted`, as(b.ann), { submitted: true });
    const s = (await state(b)).body;
    expect(s.counts.pending).toEqual(["Ben", "Cy"]);
    expect(s.counts).toMatchObject({ joined: 3, submitted: 1 });
    expect(JSON.stringify(s)).not.toContain('"votes"');
  });

  it("pushes the pending list live to the facilitator", async () => {
    const b = await voting();
    const cf = await connect(`session=${b.sid}&admin=${b.key}`);
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(b.ben), { starred: true });
    await api("PUT", `/api/s/${b.sid}/submitted`, as(b.ben), { submitted: true });
    await settle();
    const last = cf.messages.filter((m) => m.type === "counts").at(-1);
    expect(last.pending).toEqual(["Ann", "Cy"]);
  });

  it("a reminder reaches only the people who have not submitted", async () => {
    const b = await voting();
    await api("PUT", `/api/s/${b.sid}/votes/${b.first}`, as(b.ann), { starred: true });
    await api("PUT", `/api/s/${b.sid}/submitted`, as(b.ann), { submitted: true });
    const [cAnn, cBen] = [await connect(`session=${b.sid}&token=${b.ann}`), await connect(`session=${b.sid}&token=${b.ben}`)];
    await settle();
    cAnn.messages.length = cBen.messages.length = 0;
    const res = await api("POST", `/api/s/${b.sid}/admin/remind`, asAdmin(b.key));
    expect(res.body).toEqual({ reminded: 2 });
    await settle();
    expect(cBen.messages.some((m) => m.type === "nudge")).toBe(true);
    expect(cAnn.messages.some((m) => m.type === "nudge")).toBe(false);
  });

  it("limits reminders to once every few seconds, and needs the facilitator key", async () => {
    const b = await voting();
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`, as(b.ann))).status).toBe(401);
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`)).status).toBe(401);
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`, asAdmin(b.key))).status).toBe(200);
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`, asAdmin(b.key))).status).toBe(429);
  });

  it("only works while voting is open", async () => {
    const b = await makeBoard();
    await join(b.sid, "Ann");
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`, asAdmin(b.key))).status).toBe(409); // not started
    await act(b, "start");
    await act(b, "lock");
    expect((await api("POST", `/api/s/${b.sid}/admin/remind`, asAdmin(b.key))).status).toBe(409); // locked
  });
});
