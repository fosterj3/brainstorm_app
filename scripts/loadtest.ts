/**
 * Load test: many people using Ority at once, the way real people do.
 *
 *   npm run loadtest                                  50 people in one live session, in this process
 *   npm run loadtest -- --participants 50 --polls 10  500 people across 10 polls at the same time
 *   npm run loadtest -- --method rank                 dots (default), rank, score, points or mixed
 *   npm run loadtest -- --url https://your-site.example.org --polls 1   test a running site (see the note below)
 *
 * Each simulated person joins, keeps a live connection open, waits for voting to start, votes in their own
 * time (random pauses), and submits. A share of them drop their connection mid-vote and come back. Then the
 * organizer closes the poll and the test checks:
 *  - nothing failed, and every vote that was accepted is still there;
 *  - the final results match a tally worked out separately here from what people actually sent;
 *  - nobody received anyone else's votes or name, and the organizer never received individual votes;
 *  - when run in this process with a file database, the results are identical after a restart.
 * It also reports how long things took (median, 95th percentile, slowest) and how busy the server was.
 *
 * Testing a live site: creating polls is limited to 10 per hour per address, so use --polls 1 (or a few) and
 * expect the first run to leave polls behind (they delete themselves after 90 days, or delete them from
 * Your polls). Do not run it against a site you do not own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocket } from "ws";

export type Method = "dots" | "rank" | "score" | "points";

export interface LoadOptions {
  /** Test a running site instead of starting one in this process. */
  url?: string;
  participants: number;
  polls: number;
  /** One method, or "mixed" to give each poll the next method in turn. */
  method: Method | "mixed";
  options: number;
  mode: "live" | "poll";
  /** The longest random pause, in milliseconds, between one person's actions. */
  jitterMs: number;
  /** How long, in milliseconds, people take to arrive. Left out, it grows with the crowd (10 ms per person). */
  arrivalMs?: number;
  /** The share of people (0 to 1) who drop their connection mid-vote and come back. */
  reconnectShare: number;
  /** In this process only: keep the data in a file, restart, and check the results are the same. */
  restartCheck: boolean;
  /** Slowest acceptable time for 95 out of 100 votes, in milliseconds. */
  maxP95Ms: number;
  log?: (line: string) => void;
  /**
   * In this process only, for checking that the test can fail: called once everyone has voted, with the database,
   * before the results are read. Tampering with the data here must make the test report a problem.
   */
  afterVoting?: (db: import("../server/db").DB) => void;
}

export const DEFAULTS: LoadOptions = {
  participants: 50, polls: 1, method: "dots", options: 12, mode: "live",
  jitterMs: 300, reconnectShare: 0.2, restartCheck: false, maxP95Ms: 1500,
};

interface Latency { n: number; p50: number; p95: number; p99: number; max: number }
export interface LoadReport {
  ok: boolean;
  people: number;
  polls: number;
  seconds: number;
  latency: Record<string, Latency>;
  failures: string[];
  /** Requests and connections that failed once and worked on the second try, as a browser would. Should be 0 or close to it. */
  retries: number;
  server?: { rssMb: number; rssGrowthMb: number; loopDelayP99Ms: number; loopDelayMaxMs: number };
  restart?: "passed" | "failed";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pctl = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
const summarize = (values: number[]): Latency => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: pctl(s, 50), p95: pctl(s, 95), p99: pctl(s, 99), max: s.at(-1) ?? 0 };
};
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Person {
  index: number;
  name: string;
  token: string;
  /** What this person actually sent and the server accepted: option id to value. */
  ballot: Record<number, number>;
  /** Every option this person ever had a vote on, even if they later changed it. */
  ever: Set<number>;
  messages: any[];
  ws?: WebSocket;
  reconnected: boolean;
}

/** What the final tally should be, worked out here from the ballots people sent. */
function expectedTally(method: Method, people: Person[], optionIds: number[]) {
  const slots = optionIds.length <= 10 ? optionIds.length : 5;
  const rows = optionIds.map((id) => {
    let sum = 0;
    let count = 0;
    for (const p of people) {
      const v = p.ballot[id];
      if (v === undefined) continue;
      count++;
      sum += method === "dots" ? 1 : method === "rank" ? Math.max(0, slots - v + 1) : v;
    }
    return { id, count, sum, score: method === "score" ? (count ? round2(sum / count) : 0) : sum };
  });
  // Averages are compared as exact fractions, as the server does. Comparing the rounded values would treat two
  // options as tied (and order them by id) when their real averages differ by less than a hundredth.
  const higher = (a: { sum: number; count: number; score: number }, b: { sum: number; count: number; score: number }) =>
    method === "score" ? b.sum * (a.count || 1) - a.sum * (b.count || 1) : b.score - a.score;
  const order = [...rows].sort((a, b) => higher(a, b) || (method === "score" ? b.count - a.count : 0) || a.id - b.id);
  const rank = new Map<number, number>();
  order.forEach((r, i) => {
    const prev = order[i - 1];
    const same = prev && higher(prev, r) === 0 && (method !== "score" || prev.count === r.count);
    rank.set(r.id, same ? rank.get(prev.id)! : i + 1);
  });
  return { rows, rank };
}

/** Run the test and return a report. Starts a server in this process unless `url` is given. */
export async function runLoadTest(partial: Partial<LoadOptions> = {}): Promise<LoadReport> {
  const o: LoadOptions = { ...DEFAULTS, ...partial };
  const log = o.log ?? (() => {});
  const started = Date.now();
  const failures: string[] = [];
  const fail = (msg: string) => { if (failures.length < 40) failures.push(msg); };
  const timings: Record<string, number[]> = { join: [], board: [], vote: [], submit: [], push: [] };
  let retries = 0;
  const arrival = o.arrivalMs ?? Math.max(o.jitterMs * 3, o.participants * o.polls * 10);

  // ---- a server in this process, unless pointed at a running one
  let base = o.url?.replace(/\/+$/, "") ?? "";
  let closeServer = async () => {};
  let dbFile = "";
  let results = async (): Promise<unknown> => null;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let rssBefore = 0;
  const dbRef: { current?: import("../server/db").DB } = {};
  if (!o.url) {
    const { buildApp } = await import("../server/index");
    const { openDb } = await import("../server/db");
    dbFile = o.restartCheck ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ority-load-")), "load.db") : ":memory:";
    const db = openDb(dbFile);
    dbRef.current = db;
    const app = buildApp(db, { createLimit: 100_000 });
    await app.listen({ port: 0, host: "127.0.0.1", backlog: 1024 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    closeServer = async () => { await app.close(); db.close(); };
    rssBefore = process.memoryUsage().rss;
    delay.enable();
  }

  const call = async (kind: string | null, method: string, p: string, headers: Record<string, string> = {}, body?: unknown, expect = 200) => {
    const t = performance.now();
    let status = 0;
    let json: any = null;
    const send = () => fetch(base + p, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      // A browser quietly retries a request whose connection was dropped, so one retry is realistic.
      const res = await send().catch(async () => { retries++; await sleep(50 + rand(150)); return send(); });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      fail(`${method} ${p}: ${(e as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ""}`);
    }
    if (kind) timings[kind].push(performance.now() - t);
    if (status !== expect) fail(`${method} ${p} gave ${status}${json?.message ? ` (${json.message})` : ""}, expected ${expect}`);
    return { status, json };
  };

  const wsUrl = (query: string) => `${base.replace(/^http/, "ws")}/ws?${query}`;
  const connectOnce = (query: string, sink: any[]) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(query));
      ws.on("message", (d) => sink.push({ at: performance.now(), ...JSON.parse(String(d)) }));
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  // The real page reconnects by itself after a dropped connection, so the test does too.
  const connect = async (query: string, sink: any[]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await connectOnce(query, sink);
      } catch (e) {
        if (attempt >= 2) throw e;
        retries++;
        await sleep(100 * (attempt + 1) + rand(200));
      }
    }
  };

  const methods: Method[] = ["dots", "rank", "score", "points"];
  const pollMethod = (i: number): Method => (o.method === "mixed" ? methods[i % methods.length] : o.method);

  // ---- one poll with its crowd
  async function runPoll(pollIndex: number) {
    const method = pollMethod(pollIndex);
    const tag = `poll ${pollIndex + 1} (${method})`;
    const optionTitles = Array.from({ length: o.options }, (_, i) => `Option ${i + 1}`);
    const made = await call(null, "POST", "/api/sessions", {}, {
      title: `Load test ${pollIndex + 1}`, method, mode: o.mode, options: optionTitles,
      deadline: o.mode === "poll" ? Date.now() + 6 * 3_600_000 : undefined,
      settings: { votesPerPerson: 3, namedResults: true },
    });
    if (!made.json?.id) { fail(`${tag}: could not create the poll`); return; }
    const sid: string = made.json.id;
    const admin = { "x-admin-key": made.json.adminKey as string };
    const board0 = (await call(null, "GET", `/api/s/${sid}/board`)).json;
    const optionIds: number[] = board0.ideas.map((i: any) => i.id);
    const slots = board0.limits.rankSlots as number;

    const organizerMessages: any[] = [];
    const organizerWs = await connect(`session=${sid}&admin=${encodeURIComponent(made.json.adminKey)}`, organizerMessages);

    const people: Person[] = Array.from({ length: o.participants }, (_, i) => ({
      index: i, name: `Tester ${String(pollIndex + 1).padStart(2, "0")}-${String(i + 1).padStart(3, "0")}`, token: "", ballot: {}, ever: new Set<number>(), messages: [], reconnected: false,
    }));

    let joined = 0;
    let allJoined!: () => void;
    const joinBarrier = new Promise<void>((r) => (allJoined = r));
    let startedAt = 0;

    /** Votes, in the way people of this poll's method would. Records exactly what the server accepted. */
    async function vote(p: Person) {
      const mine = { "x-participant-token": p.token };
      const pause = () => sleep(rand(o.jitterMs));
      const dropAndReturn = async () => {
        if (!p.reconnected && Math.random() < o.reconnectShare) {
          p.reconnected = true;
          p.ws?.terminate();
          await sleep(rand(200));
          p.ws = await connect(`session=${sid}&token=${encodeURIComponent(p.token)}`, p.messages);
          // Coming back must not lose anything: the server's copy has to match what was already accepted.
          const me = (await call("board", "GET", `/api/s/${sid}/board`, mine)).json?.me;
          const got = JSON.stringify(Object.entries(me?.ballot ?? {}).map(([k, v]) => [Number(k), v]).sort());
          const had = JSON.stringify(Object.entries(p.ballot).map(([k, v]) => [Number(k), v]).sort());
          if (got !== had) fail(`${tag}: ${p.name} lost votes while reconnecting`);
        }
      };

      if (method === "dots") {
        const picks = shuffle(optionIds).slice(0, 3 + 1); // one more than allowed, to see the cap hold
        let held = 0;
        for (const id of picks) {
          await pause();
          const expect = held >= 3 ? 409 : 200;
          const r = await call("vote", "PUT", `/api/s/${sid}/votes/${id}`, mine, { starred: true }, expect);
          if (r.status === 200) { p.ballot[id] = 1; p.ever.add(id); held++; }
          if (held === 2) await dropAndReturn();
        }
        const [first] = Object.keys(p.ballot).map(Number); // change of mind: take one back and choose another
        await pause();
        if ((await call("vote", "PUT", `/api/s/${sid}/votes/${first}`, mine, { starred: false })).status === 200) delete p.ballot[first];
        const other = optionIds.find((id) => p.ballot[id] === undefined && id !== first) ?? first;
        await pause();
        if ((await call("vote", "PUT", `/api/s/${sid}/votes/${other}`, mine, { starred: true })).status === 200) { p.ballot[other] = 1; p.ever.add(other); }
      } else {
        const send = async (values: Record<number, number>) => {
          const r = await call("vote", "PUT", `/api/s/${sid}/ballot`, mine, { values });
          if (r.status === 200) {
            p.ballot = Object.fromEntries(Object.entries(values).filter(([, v]) => v > 0).map(([k, v]) => [Number(k), v]));
            Object.keys(p.ballot).forEach((k) => p.ever.add(Number(k)));
          }
        };
        await pause();
        if (method === "rank") {
          await send(Object.fromEntries(shuffle(optionIds).slice(0, slots).map((id, i) => [id, i + 1])));
          await dropAndReturn();
          await pause();
          await send(Object.fromEntries(shuffle(optionIds).slice(0, slots).map((id, i) => [id, i + 1]))); // changed their mind
        } else if (method === "score") {
          const rated = shuffle(optionIds).slice(0, 1 + rand(optionIds.length));
          await send(Object.fromEntries(rated.slice(0, Math.ceil(rated.length / 2)).map((id) => [id, 1 + rand(5)])));
          await dropAndReturn();
          await pause();
          await send(Object.fromEntries(rated.map((id) => [id, 1 + rand(5)])));
        } else {
          const chosen = shuffle(optionIds).slice(0, 2 + rand(4));
          const split = (total: number) => {
            const cuts = Array.from({ length: chosen.length - 1 }, () => rand(total + 1)).sort((a, b) => a - b);
            return [...cuts, total].map((c, i) => c - (cuts[i - 1] ?? 0));
          };
          const first = split(60);
          await send(Object.fromEntries(chosen.map((id, i) => [id, first[i]]))); // a draft that is not finished yet
          await dropAndReturn();
          await pause();
          const full = split(100);
          await send(Object.fromEntries(chosen.map((id, i) => [id, full[i]])));
        }
      }
      await pause();
      await call("submit", "PUT", `/api/s/${sid}/submitted`, mine, { submitted: true });
    }

    async function person(p: Person) {
      await sleep(rand(arrival)); // people arrive over a few moments
      const j = await call("join", "POST", `/api/s/${sid}/join`, {}, { name: p.name });
      p.token = j.json?.token ?? "";
      if (!p.token) return fail(`${tag}: ${p.name} could not join`);
      p.ws = await connect(`session=${sid}&token=${encodeURIComponent(p.token)}`, p.messages);
      await call("board", "GET", `/api/s/${sid}/board`, { "x-participant-token": p.token });
      if (++joined === o.participants) allJoined();
      await joinBarrier;
      // Wait for voting to open. A live session waits for the organizer. An open poll is already open.
      for (let i = 0; i < 400; i++) {
        const phase = (await call(null, "GET", `/api/s/${sid}/board`, { "x-participant-token": p.token })).json?.settings?.phase;
        if (phase === "voting") break;
        await sleep(25);
      }
      await vote(p);
    }

    const crowd = Promise.all(people.map((p) => person(p).catch((e) => {
      fail(`${tag}: ${p.name} stopped: ${e instanceof Error ? e.message : e}`);
      if (++joined >= o.participants) allJoined(); // do not leave everyone else waiting
    })));
    await joinBarrier;
    if (o.mode === "live") {
      await sleep(100);
      startedAt = performance.now();
      await call(null, "POST", `/api/s/${sid}/admin/action`, admin, { action: "start" });
    }
    await crowd;
    await sleep(150); // let the last messages arrive

    // Push latency: how soon each person's screen heard that voting had started.
    if (startedAt) for (const p of people) {
      const hit = p.messages.find((m) => m.type === "refresh" && m.at >= startedAt);
      if (hit) timings.push.push(hit.at - startedAt);
    }

    // Privacy: people only ever get their own votes, never another person's name or the organizer's counts.
    // The organizer never gets individual votes. (A push can be older than the final ballot, so the check is that
    // everything a person was sent is something they themselves voted for at some point.)
    for (const p of people) {
      for (const m of p.messages) {
        if (m.type === "votes") {
          const sent = [...(Array.isArray(m.votes) ? m.votes : []), ...Object.keys(m.ballot ?? {}).map(Number)];
          if (sent.some((id: number) => !p.ever.has(id))) fail(`${tag}: ${p.name} was sent a vote that is not theirs`);
        }
        if (m.type === "counts") fail(`${tag}: ${p.name} received the organizer's counts`);
        const text = JSON.stringify(m);
        for (const other of people) if (other !== p && text.includes(other.name)) fail(`${tag}: ${p.name} received the name ${other.name}`);
      }
    }    if (organizerMessages.some((m) => m.type === "votes")) fail(`${tag}: the organizer received individual votes`);
    const lastCounts = organizerMessages.filter((m) => m.type === "counts").at(-1);
    if (!lastCounts || lastCounts.joined !== o.participants || lastCounts.submitted !== o.participants) {
      fail(`${tag}: organizer counts were ${lastCounts ? `${lastCounts.joined} joined and ${lastCounts.submitted} submitted` : "never received"}, expected ${o.participants} of each`);
    }

    if (o.afterVoting && dbRef.current) o.afterVoting(dbRef.current);

    // Each person's own copy matches what they sent.
    await Promise.all(people.map(async (p) => {
      const me = (await call("board", "GET", `/api/s/${sid}/board`, { "x-participant-token": p.token })).json?.me;
      const got = Object.entries(me?.ballot ?? {}).map(([k, v]) => [Number(k), v]).sort().join("|");
      const had = Object.entries(p.ballot).map(([k, v]) => [Number(k), v]).sort().join("|");
      if (got !== had) fail(`${tag}: ${p.name}'s saved votes differ from what they sent`);
      if (!me?.submitted) fail(`${tag}: ${p.name} is not marked as submitted`);
    }));

    // Close the poll and compare the results with the independent tally.
    if (o.mode === "live") {
      await call(null, "POST", `/api/s/${sid}/admin/action`, admin, { action: "lock" });
      await call(null, "POST", `/api/s/${sid}/admin/action`, admin, { action: "reveal" });
    } else {
      await call(null, "POST", `/api/s/${sid}/admin/action`, admin, { action: "close" });
    }
    const res = (await call(null, "GET", `/api/s/${sid}/admin/results`, admin)).json;
    const want = expectedTally(method, people, optionIds);
    if (!res?.rows) fail(`${tag}: no results`);
    else {
      for (const row of res.rows) {
        const w = want.rows.find((r) => r.id === row.id)!;
        if (Math.abs(row.stars - w.score) > 0.011) fail(`${tag}: option ${row.id} scored ${row.stars}, expected ${w.score}`);
        if (row.rank !== want.rank.get(row.id)) fail(`${tag}: option ${row.id} ranked ${row.rank}, expected ${want.rank.get(row.id)}`);
      }
      if (res.totals.voted !== o.participants) fail(`${tag}: ${res.totals.voted} people voted, expected ${o.participants}`);
    }
    log(`${tag}: ${o.participants} people done`);
    organizerWs.close();
    people.forEach((p) => p.ws?.close());
    return { sid, admin, res };
  }

  const outcomes = await Promise.all(Array.from({ length: o.polls }, (_, i) => runPoll(i).catch((e) => { fail(`poll ${i + 1} crashed: ${e instanceof Error ? e.message : e}`); })));

  // ---- after a restart, the results must be exactly the same
  let restart: LoadReport["restart"];
  if (!o.url && o.restartCheck && dbFile !== ":memory:") {
    const before = outcomes.map((x) => JSON.stringify(x?.res?.rows?.map((r: any) => [r.id, r.stars, r.rank])));
    await closeServer();
    const { buildApp } = await import("../server/index");
    const { openDb } = await import("../server/db");
    const db = openDb(dbFile);
    const app = buildApp(db, { createLimit: 100_000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    results = async () => null;
    let same = true;
    for (let i = 0; i < outcomes.length; i++) {
      const out = outcomes[i];
      if (!out) continue;
      const again = (await call(null, "GET", `/api/s/${out.sid}/admin/results`, out.admin)).json;
      const now = JSON.stringify(again?.rows?.map((r: any) => [r.id, r.stars, r.rank]));
      if (now !== before[i]) same = false;
    }
    restart = same ? "passed" : "failed";
    if (!same) fail("results changed after a restart");
    closeServer = async () => { await app.close(); db.close(); };
  }
  void results;

  const memory = process.memoryUsage().rss;
  delay.disable();
  await closeServer();
  if (dbFile && dbFile !== ":memory:") fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });

  const latency = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, summarize(v)]));
  if (latency.vote.p95 > o.maxP95Ms) fail(`95% of votes should finish within ${o.maxP95Ms} ms, but the 95th percentile was ${Math.round(latency.vote.p95)} ms`);
  return {
    ok: failures.length === 0,
    retries,
    people: o.participants * o.polls,
    polls: o.polls,
    seconds: round2((Date.now() - started) / 1000),
    latency,
    failures,
    server: o.url ? undefined : {
      rssMb: Math.round(memory / 1048576),
      rssGrowthMb: Math.round((memory - rssBefore) / 1048576),
      loopDelayP99Ms: round2(delay.percentile(99) / 1e6),
      loopDelayMaxMs: round2(delay.max / 1e6),
    },
    restart,
  };
}

export function formatReport(r: LoadReport): string {
  const ms = (n: number) => `${Math.round(n)} ms`;
  const rows = Object.entries(r.latency)
    .filter(([, v]) => v.n > 0)
    .map(([k, v]) => `  ${k.padEnd(7)} ${String(v.n).padStart(6)} requests   median ${ms(v.p50).padStart(8)}   95th ${ms(v.p95).padStart(8)}   99th ${ms(v.p99).padStart(8)}   slowest ${ms(v.max).padStart(8)}`);
  return [
    `${r.ok ? "PASSED" : "FAILED"}: ${r.people} people in ${r.polls} ${r.polls === 1 ? "poll" : "polls"}, ${r.seconds} seconds`,
    ...rows,
    ...(r.retries ? [`  note    ${r.retries} requests or connections needed a second try`] : []),
    ...(r.server ? [`  server  memory ${r.server.rssMb} MB (grew ${r.server.rssGrowthMb} MB), busiest moment delayed work by ${r.server.loopDelayMaxMs} ms (99th: ${r.server.loopDelayP99Ms} ms)`] : []),
    ...(r.restart ? [`  restart results identical after restart: ${r.restart}`] : []),
    ...(r.failures.length ? ["", "Problems:", ...r.failures.map((f) => `  - ${f}`)] : []),
  ].join("\n");
}

// ---- command line
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "loadtest.ts");
if (isMain) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const num = (name: string, fallback: number) => (arg(name) !== undefined ? Number(arg(name)) : fallback);
  const method = (arg("method") ?? DEFAULTS.method) as LoadOptions["method"];
  if (!["dots", "rank", "score", "points", "mixed"].includes(method)) { console.error("--method must be dots, rank, score, points or mixed"); process.exit(2); }
  const report = await runLoadTest({
    url: arg("url"), participants: num("participants", DEFAULTS.participants), polls: num("polls", DEFAULTS.polls), method,
    options: num("options", DEFAULTS.options), mode: (arg("mode") as LoadOptions["mode"]) ?? DEFAULTS.mode, jitterMs: num("jitter", DEFAULTS.jitterMs),
    arrivalMs: arg("arrival") !== undefined ? num("arrival", 0) : undefined,
    reconnectShare: num("reconnect", DEFAULTS.reconnectShare), restartCheck: process.argv.includes("--restart"), maxP95Ms: num("max-p95", DEFAULTS.maxP95Ms),
    log: (l) => console.log(l),
  });
  console.log("\n" + formatReport(report));
  process.exit(report.ok ? 0 : 1);
}
