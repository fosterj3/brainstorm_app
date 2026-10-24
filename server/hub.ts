import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { DB } from "./db";
import { verifyAdmin } from "./sessions";
import { getParticipant } from "./votes";

type Role = { sid: string } & ({ kind: "participant"; token: string } | { kind: "facilitator" });

/**
 * Push channel, one room per session. Mutations go over HTTP (simple and safe to retry); the hub pushes the
 * results to everyone in that session who needs them. Clients refetch the full state whenever a socket
 * (re)connects, so a missed push can never leave them out of date.
 */
export class Hub {
  private wss = new WebSocketServer({ noServer: true });
  private roles = new Map<WebSocket, Role>();
  private alive = new WeakSet<WebSocket>();
  private timer: NodeJS.Timeout;
  private closed = false;
  /** Called when someone connects or disconnects, so the organizer's headcount stays current. */
  onPresence: (sid: string) => void = () => {};

  /**
   * Tell the organizer someone came or went. This runs inside a connection event, where an error that nobody
   * catches would stop the whole server, so a problem here (a database error, or the server shutting down) is
   * kept to that one notification.
   */
  private presence(sid: string) {
    if (this.closed) return;
    try {
      this.onPresence(sid);
    } catch (e) {
      console.error("Could not update the headcount:", e instanceof Error ? e.message : e);
    }
  }

  constructor(server: http.Server, db: DB) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const sid = url.searchParams.get("session") ?? "";
      const token = url.searchParams.get("token");
      const admin = url.searchParams.get("admin");
      let role: Role | null = null;
      try {
        if (url.pathname === "/ws" && sid && !this.closed) {
          if (admin && verifyAdmin(db, sid, admin)) role = { sid, kind: "facilitator" };
          else if (token && getParticipant(db, sid, token)) role = { sid, kind: "participant", token };
        }
      } catch {
        role = null; // the database could not answer: refuse this connection rather than crash
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
          this.presence(role!.sid);
        });
        ws.on("error", () => ws.terminate());
        this.presence(role!.sid);
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

  /** Number of distinct participants of this session with an open connection. */
  connected(sid: string): number {
    const tokens = new Set<string>();
    for (const r of this.roles.values()) if (r.sid === sid && r.kind === "participant") tokens.add(r.token);
    return tokens.size;
  }

  private send(ws: WebSocket, data: string) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  /** To every participant of the session. */
  broadcast(sid: string, msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.sid === sid && r.kind === "participant") this.send(ws, data);
  }

  /** To every open tab/device of one participant. */
  sendToToken(sid: string, token: string, msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.sid === sid && r.kind === "participant" && r.token === token) this.send(ws, data);
  }

  toFacilitators(sid: string, msg: unknown) {
    const data = JSON.stringify(msg);
    for (const [ws, r] of this.roles) if (r.sid === sid && r.kind === "facilitator") this.send(ws, data);
  }

  /** Tell everyone in the session (participants and facilitator) to refetch their state. */
  refreshAll(sid: string) {
    const data = JSON.stringify({ type: "refresh" });
    for (const [ws, r] of this.roles) if (r.sid === sid) this.send(ws, data);
  }

  /** The board was deleted: tell everyone in it, then close their connections. */
  closeSession(sid: string) {
    const data = JSON.stringify({ type: "deleted" });
    for (const [ws, r] of this.roles) {
      if (r.sid !== sid) continue;
      this.send(ws, data);
      ws.close(1000, "deleted");
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const ws of this.roles.keys()) ws.terminate();
    this.wss.close();
  }
}
