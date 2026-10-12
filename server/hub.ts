import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { DB } from "./db";
import { getParticipant } from "./votes";

type Role = { kind: "participant"; token: string } | { kind: "facilitator" };

/**
 * Push channel. Mutations go over HTTP (simple and safe to retry); the hub pushes the results
 * to everyone who needs them. Clients refetch the full state whenever a socket (re)connects,
 * so a missed push can never leave them out of date.
 */
export class Hub {
  private wss = new WebSocketServer({ noServer: true });
  private roles = new Map<WebSocket, Role>();
  private alive = new WeakSet<WebSocket>();
  private timer: NodeJS.Timeout;
  /** Called when a participant connects or disconnects, so the facilitator's headcount stays current. */
  onPresence: () => void = () => {};

  constructor(server: http.Server, db: DB, verifyFacilitator: (token: string) => boolean) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      const fac = url.searchParams.get("facilitator");
      let role: Role | null = null;
      if (url.pathname === "/ws") {
        if (fac && verifyFacilitator(fac)) role = { kind: "facilitator" };
        else if (token && getParticipant(db, token)) role = { kind: "participant", token };
      }
      if (!role) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.roles.set(ws, role!);
        this.alive.add(ws);
        ws.on("pong", () => this.alive.add(ws));
        ws.on("close", () => {
          this.roles.delete(ws);
          this.onPresence();
        });
        ws.on("error", () => ws.terminate());
        this.onPresence();
      });
    });

    // Drop connections that stopped answering pings (phone asleep, wifi gone).
    this.timer = setInterval(() => {
      for (const ws of this.roles.keys()) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, 30_000);
    this.timer.unref();
  }

  /** Number of distinct participants with an open connection. */
  connected(): number {
    const tokens = new Set<string>();
    for (const r of this.roles.values()) if (r.kind === "participant") tokens.add(r.token);
    return tokens.size;
  }

  private send(ws: WebSocket, data: string) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  /** To every participant. */
  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.kind === "participant") this.send(ws, data);
  }

  /** To every open tab/device of one participant. */
  sendToToken(token: string, msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.kind === "participant" && r.token === token) this.send(ws, data);
  }

  toFacilitators(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.kind === "facilitator") this.send(ws, data);
  }

  /** Tell everyone (participants and facilitator) to refetch their state. */
  refreshAll() {
    const data = JSON.stringify({ type: "refresh" });
    for (const ws of this.roles.keys()) this.send(ws, data);
  }

  close() {
    clearInterval(this.timer);
    for (const ws of this.roles.keys()) ws.terminate();
    this.wss.close();
  }
}
