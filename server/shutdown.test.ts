import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./index";
import { openDb } from "./db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a connection event never takes the server down", () => {
  const open: WebSocket[] = [];
  afterEach(() => {
    open.splice(0).forEach((s) => s.terminate());
    vi.restoreAllMocks();
  });

  async function boot() {
    const db = openDb(":memory:");
    const app = buildApp(db);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const made = await (await fetch(`http://${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "P", options: ["A", "B"] }) })).json() as { id: string; adminKey: string };
    const joined = await (await fetch(`http://${base}/api/s/${made.id}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ann" }) })).json() as { token: string };
    const connect = (query: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://${base}/ws?${query}`);
        open.push(ws);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    return { db, app, made, joined, connect };
  }

  it("connections that close after the database is closed are ignored, not fatal", async () => {
    const { db, app, made, joined, connect } = await boot();
    const org = await connect(`session=${made.id}&admin=${made.adminKey}`);
    const ann = await connect(`session=${made.id}&token=${joined.token}`);
    await sleep(100);
    // Connections are closing at the moment the app stops and the database closes, so the server sees the
    // "closed" events after the database is gone. This used to crash the process.
    org.terminate();
    ann.terminate();
    await app.close();
    db.close();
    await sleep(300); // an uncaught error here would fail the test run
    expect(true).toBe(true);
  });

  it("a database error while updating the headcount is logged and the connection still works", async () => {
    const { db, app, made, joined, connect } = await boot();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ann = await connect(`session=${made.id}&token=${joined.token}`);
    const real = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("FROM participants WHERE session_id = ? AND submitted")) throw new Error("disk is full");
      return real(sql);
    }) as typeof db.prepare;
    const second = await connect(`session=${made.id}&token=${joined.token}`); // triggers the headcount update, which now fails
    await sleep(150);
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(ann.readyState).toBe(WebSocket.OPEN);
    expect(errors).toHaveBeenCalledWith("Could not update the headcount:", "disk is full");
    db.prepare = real as typeof db.prepare;
    ann.terminate();
    second.terminate();
    await app.close();
  });

  it("refuses a new connection instead of crashing when the database cannot answer", async () => {
    const { db, app, made, joined, connect } = await boot();
    const real = db.prepare.bind(db);
    db.prepare = (() => { throw new Error("database unavailable"); }) as typeof db.prepare;
    await expect(connect(`session=${made.id}&token=${joined.token}`)).rejects.toBeTruthy();
    db.prepare = real as typeof db.prepare;
    // And the server is still alive afterwards.
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    await app.close();
  });
});
