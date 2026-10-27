import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./index";
import { openDb } from "./db";
import { deviceFromUserAgent, networkCode, similarNames } from "./people";
import { createSession } from "./sessions";
import { applyAction } from "./session";
import { listIdeas } from "./ideas";
import { join, listPeople, removeParticipant, setBallot, setSubmitted, setVote } from "./votes";

/**
 * What the organizer can learn about each person: when they joined and submitted, how long it took, a general device
 * type, and hints that two people may be the same person. An address or a full browser string is never stored.
 */
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("device type", () => {
  it.each([
    [CHROME_WIN, "Chrome on Windows"],
    [CHROME_WIN + " Edg/126.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Mac"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on Mac"],
    [SAFARI_IPHONE, "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iPad"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
  ])("names %s", (ua, expected) => {
    expect(deviceFromUserAgent(ua)).toBe(expected);
  });
  it("is empty without a browser string and generic for unknown ones", () => {
    expect(deviceFromUserAgent(undefined)).toBe("");
    expect(deviceFromUserAgent("   ")).toBe("");
    expect(deviceFromUserAgent("curl/8.0.1")).toBe("Other device");
    expect(deviceFromUserAgent("x".repeat(100_000))).toBe("Other device");
  });
});

describe("network code", () => {
  const salt = "poll-one";
  it("is five hex characters, the same for the same network and key", () => {
    const a = networkCode("203.0.113.7", salt);
    expect(a).toMatch(/^[0-9a-f]{5}$/);
    expect(networkCode("203.0.113.7", salt)).toBe(a);
  });
  it("differs between networks and between polls, so it cannot be matched across polls", () => {
    expect(networkCode("203.0.113.7", salt)).not.toBe(networkCode("203.0.113.8", salt));
    expect(networkCode("203.0.113.7", salt)).not.toBe(networkCode("203.0.113.7", "poll-two"));
  });
  it("treats one IPv6 home or office network as one, and an IPv4-mapped address as plain IPv4", () => {
    expect(networkCode("2001:db8:1:2:aaaa::1", salt)).toBe(networkCode("2001:0db8:0001:0002::ffff", salt));
    expect(networkCode("2001:db8:1:2::1", salt)).not.toBe(networkCode("2001:db8:1:3::1", salt));
    expect(networkCode("::ffff:203.0.113.7", salt)).toBe(networkCode("203.0.113.7", salt));
    expect(networkCode("::1", salt)).toMatch(/^[0-9a-f]{5}$/);
  });
  it("is empty when there is no address", () => {
    expect(networkCode(undefined, salt)).toBe("");
    expect(networkCode("", salt)).toBe("");
  });
});

describe("similar names", () => {
  it.each([
    ["Ann", "ann"],
    ["Ann R.", "ann r"],
    ["Ann", "Ann Reyes"],
    ["Ann (phone)", "Ann"],
    ["Jonathan", "Jonathon"],
    ["José", "Jose"],
  ])("%s and %s look alike", (a, b) => expect(similarNames(a, b)).toBe(true));
  it.each([
    ["Ann", "Ben"],
    ["Al", "Alan"],
    ["Sam", "Pam"],
    ["Maria", "Marcus"],
    ["", "Ann"],
    ["!!!", "???"],
  ])("%s and %s are left alone", (a, b) => expect(similarNames(a, b)).toBe(false));
});

function livePoll() {
  const db = openDb(":memory:");
  const { id } = createSession(db, { title: "Where?", options: ["Lodge", "City", "Mountain"] }, 0);
  applyAction(db, id, "start", 1);
  return { db, sid: id, ideas: listIdeas(db, id) };
}

describe("what is recorded about each person", () => {
  it("keeps when they joined, their device type, and when and how fast they submitted", () => {
    const { db, sid, ideas } = livePoll();
    const ann = join(db, sid, "Ann", null, { now: 1_000_000, ip: "203.0.113.7", userAgent: CHROME_WIN }).token;
    setVote(db, sid, ann, ideas[0].id, true);
    expect(listPeople(db, sid)[0]).toMatchObject({ name: "Ann", joinedAt: 1_000_000, device: "Chrome on Windows", submitted: false, submittedAt: null, tookMs: null });
    setSubmitted(db, sid, ann, true, 1_042_000);
    expect(listPeople(db, sid)[0]).toMatchObject({ submitted: true, submittedAt: 1_042_000, tookMs: 42_000 });
  });
  it("forgets the submit time when someone un-submits", () => {
    const { db, sid, ideas } = livePoll();
    const ann = join(db, sid, "Ann", null, { now: 10 }).token;
    setVote(db, sid, ann, ideas[0].id, true);
    setSubmitted(db, sid, ann, true, 50);
    setSubmitted(db, sid, ann, false, 60);
    expect(listPeople(db, sid)[0]).toMatchObject({ submitted: false, submittedAt: null, tookMs: null });
  });
  it("forgets the submit time when an edit leaves a ranked ballot unfinished", () => {
    const db = openDb(":memory:");
    const { id } = createSession(db, { title: "Rank", method: "rank", mode: "poll", deadline: Date.now() + 3_600_000, options: ["A", "B", "C"] });
    const ideas = listIdeas(db, id);
    const ann = join(db, id, "Ann", null, { now: 100 }).token;
    setBallot(db, id, ann, { [ideas[0].id]: 1, [ideas[1].id]: 2, [ideas[2].id]: 3 });
    setSubmitted(db, id, ann, true, 500);
    expect(listPeople(db, id)[0].tookMs).toBe(400);
    setBallot(db, id, ann, { [ideas[0].id]: 1 });
    expect(listPeople(db, id)[0]).toMatchObject({ submitted: false, submittedAt: null });
  });
  it("works without any connection details, as in older code and tests", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann");
    expect(listPeople(db, sid)[0]).toMatchObject({ device: "", sameNetwork: [], similarNames: [] });
    expect(listPeople(db, sid)[0].joinedAt).toBeGreaterThan(0);
  });
  it("never stores the address or the browser string", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann", null, { now: 1, ip: "203.0.113.77", userAgent: CHROME_WIN });
    const everything = JSON.stringify([db.prepare("SELECT * FROM participants").all(), db.prepare("SELECT * FROM settings").all(), db.prepare("SELECT * FROM sessions").all()]);
    expect(everything).not.toContain("203.0.113.77");
    expect(everything).not.toContain("Mozilla");
    expect(everything).not.toContain("Windows NT");
  });
});

describe("hints that two people may be the same person", () => {
  it("flags people on the same network, but not people on different ones", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann", null, { ip: "203.0.113.7", userAgent: CHROME_WIN });
    join(db, sid, "Zed", null, { ip: "203.0.113.7", userAgent: SAFARI_IPHONE });
    join(db, sid, "Bo", null, { ip: "198.51.100.9" });
    const by = Object.fromEntries(listPeople(db, sid).map((p) => [p.name, p]));
    expect(by.Ann.sameNetwork).toEqual(["Zed"]);
    expect(by.Zed.sameNetwork).toEqual(["Ann"]);
    expect(by.Bo.sameNetwork).toEqual([]);
    expect(by.Ann.device).not.toBe(by.Zed.device); // same person, laptop and phone
  });
  it("does not match people when no address was known", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann");
    join(db, sid, "Ben");
    expect(listPeople(db, sid).every((p) => p.sameNetwork.length === 0)).toBe(true);
  });
  it("flags similar names both ways", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann");
    join(db, sid, "Ann R.");
    join(db, sid, "Ben");
    const by = Object.fromEntries(listPeople(db, sid).map((p) => [p.name, p]));
    expect(by.Ann.similarNames).toEqual(["Ann R."]);
    expect(by["Ann R."].similarNames).toEqual(["Ann"]);
    expect(by.Ben.similarNames).toEqual([]);
  });
  it("stops flagging once the earlier response is removed", () => {
    const { db, sid } = livePoll();
    join(db, sid, "Ann", null, { ip: "203.0.113.7" });
    join(db, sid, "Ann (phone)", null, { ip: "203.0.113.7" });
    removeParticipant(db, sid, "Ann");
    expect(listPeople(db, sid)[0]).toMatchObject({ name: "Ann (phone)", sameNetwork: [], similarNames: [] });
  });
  it("uses a different key for every poll, so the same network gets different codes", () => {
    const db = openDb(":memory:");
    const one = createSession(db, { title: "One" }, 0).id;
    const two = createSession(db, { title: "Two" }, 0).id;
    join(db, one, "Ann", null, { ip: "203.0.113.7" });
    join(db, two, "Ann", null, { ip: "203.0.113.7" });
    const code = (sid: string) => (db.prepare("SELECT net FROM participants WHERE session_id = ?").get(sid) as { net: string }).net;
    expect(code(one)).not.toBe(code(two));
  });
});

describe("databases made before these details existed", () => {
  it("open fine, and show people without details", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ority-people-"));
    const file = path.join(dir, "old.db");
    try {
      const first = openDb(file);
      const { id } = createSession(first, { title: "Old", options: ["A", "B"] }, 0);
      join(first, id, "Ann", null, { now: 5 });
      for (const col of ["joined_at", "submitted_at", "device", "net"]) first.exec(`ALTER TABLE participants DROP COLUMN ${col}`);
      first.close();

      const second = openDb(file); // an upgrade adds the columns back
      expect(listPeople(second, id)[0]).toMatchObject({ name: "Ann", joinedAt: null, submittedAt: null, tookMs: null, device: "", sameNetwork: [], similarNames: [] });
      expect(join(second, id, "Ben", null, { now: 9, userAgent: CHROME_WIN }).name).toBe("Ben");
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("over HTTP", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  async function boot() {
    app = buildApp(openDb(":memory:"), { trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    return async (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
  }
  const create = async (call: Awaited<ReturnType<typeof boot>>) => {
    const made = (await call("POST", "/api/sessions", {}, { title: "Open", mode: "poll", deadline: Date.now() + 3_600_000, options: ["A", "B", "C"] })).body;
    return { sid: made.id as string, admin: { "x-admin-key": made.adminKey as string } };
  };

  it("records the device and network from the request, and shows them only to the organizer", async () => {
    const call = await boot();
    const { sid, admin } = await create(call);
    const joined = await call("POST", `/api/s/${sid}/join`, { "user-agent": CHROME_WIN, "x-forwarded-for": "203.0.113.7" }, { name: "Ann" });
    await call("POST", `/api/s/${sid}/join`, { "user-agent": SAFARI_IPHONE, "x-forwarded-for": "203.0.113.7" }, { name: "Ann (phone)" });
    await call("POST", `/api/s/${sid}/join`, { "user-agent": CHROME_WIN, "x-forwarded-for": "198.51.100.9" }, { name: "Cy" });

    const people = (await call("GET", `/api/s/${sid}/admin/people`, admin)).body.people as any[];
    const by = Object.fromEntries(people.map((p) => [p.name, p]));
    expect(by.Ann).toMatchObject({ device: "Chrome on Windows", sameNetwork: ["Ann (phone)"], similarNames: ["Ann (phone)"] });
    expect(by["Ann (phone)"]).toMatchObject({ device: "Safari on iPhone", sameNetwork: ["Ann"] });
    expect(by.Cy).toMatchObject({ sameNetwork: [], similarNames: [] });
    expect(JSON.stringify(people)).not.toContain("203.0.113.7");

    // Nothing a participant can fetch carries it.
    const token = { "x-participant-token": joined.body.token as string };
    const mine = JSON.stringify([joined.body, (await call("GET", `/api/s/${sid}/board`, token)).body, (await call("GET", `/api/s/${sid}/exists`)).body]);
    for (const word of ["device", "sameNetwork", "similarNames", "joinedAt", "Chrome on Windows"]) expect(mine).not.toContain(word);
    // And not the organizer's live view either.
    expect(JSON.stringify((await call("GET", `/api/s/${sid}/admin/state`, admin)).body)).not.toContain("Chrome on Windows");
  });

  it("records when someone submits", async () => {
    const call = await boot();
    const { sid, admin } = await create(call);
    const token = { "x-participant-token": (await call("POST", `/api/s/${sid}/join`, {}, { name: "Ann" })).body.token as string };
    const ideaId = (await call("GET", `/api/s/${sid}/board`, token)).body.ideas[0].id;
    await call("PUT", `/api/s/${sid}/votes/${ideaId}`, token, { starred: true });
    await call("PUT", `/api/s/${sid}/submitted`, token, { submitted: true });
    const ann = (await call("GET", `/api/s/${sid}/admin/people`, admin)).body.people[0];
    expect(ann.submitted).toBe(true);
    expect(ann.submittedAt).toBeGreaterThanOrEqual(ann.joinedAt);
    expect(ann.tookMs).toBe(ann.submittedAt - ann.joinedAt);
  });
});
