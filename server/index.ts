import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { openDb, type DB } from "./db";
import { createThrottle } from "./auth";
import { HTTP_STATUS, VoteError } from "./errors";
import { Hub } from "./hub";
import {
  createColumn, createIdea, deleteColumn, deleteIdea, exportBoard, importBoard, listColumns, listIdeas, listIdeasForFacilitator,
  mergeIdeas, moveColumn, parseIdeas, updateColumn, updateIdea,
} from "./ideas";
import { applyAction, getSettings, reconcile, updateSettings, type Action } from "./session";
import { createSession, getBoardMeta, purgeIdle, sessionsWithRunningTimer, touch, updateBoardMeta, verifyAdmin } from "./sessions";
import { addIdea, countIdeasBy, getCounts, getParticipant, getVotes, join, setSubmitted, setVote } from "./votes";

export interface AppOptions {
  now?: () => number;
  /** Set when running behind a hosting proxy so the real client IP (not the proxy's) is used for rate limits. */
  trustProxy?: boolean;
  /** Boards created per client per hour. */
  createLimit?: number;
}

const ACTIONS: Action[] = ["start", "pause", "resume", "extend", "lock", "reopen"];
const IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export function buildApp(db: DB, opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  const createThrottled = createThrottle(opts.createLimit ?? 10, 60 * 60 * 1000, now);
  const hub = new Hub(app.server, db);

  const counts = (sid: string) => ({ ...getCounts(db, sid), connected: hub.connected(sid) });
  const pushCounts = (sid: string) => hub.toFacilitators(sid, { type: "counts", ...counts(sid) });
  hub.onPresence = pushCounts;

  // When a running timer reaches zero, mark it ended (and auto-lock if chosen), then tell everyone in that session.
  const expiry = new Map<string, NodeJS.Timeout>();
  const scheduleExpiry = (sid: string) => {
    clearTimeout(expiry.get(sid));
    expiry.delete(sid);
    const { timer } = getSettings(db, sid);
    if (timer.state !== "running" || timer.endsAt === null) return;
    const t = setTimeout(() => {
      if (reconcile(db, sid, now())) hub.refreshAll(sid);
      scheduleExpiry(sid);
    }, Math.max(0, timer.endsAt - now()) + 20);
    t.unref();
    expiry.set(sid, t);
  };
  for (const sid of sessionsWithRunningTimer(db)) scheduleExpiry(sid);

  purgeIdle(db, now(), IDLE_MS);
  const purger = setInterval(() => purgeIdle(db, now(), IDLE_MS), 6 * 60 * 60 * 1000);
  purger.unref();

  app.addHook("onClose", async () => {
    clearInterval(purger);
    for (const t of expiry.values()) clearTimeout(t);
    hub.close();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof VoteError) return reply.code(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "bad_input", message: "That request was not valid." });
    return reply.code(500).send({ error: "server_error", message: "Something went wrong." });
  });

  // ---- creating a board -------------------------------------------------------------------

  app.post<{ Body: { title?: string; subtitle?: string; template?: string } }>("/api/sessions", async (req) => {
    if (createThrottled.blocked(req.ip)) throw new VoteError("rate_limited", "You have created a lot of boards recently. Please try again later.");
    const result = createSession(db, req.body ?? {}, now());
    createThrottled.record(req.ip);
    return result;
  });

  /** Looks up a session for the join screen without revealing anything private. */
  app.get<{ Params: { sid: string } }>("/api/s/:sid/exists", async (req) => {
    const meta = getBoardMeta(db, req.params.sid);
    if (!meta) throw new VoteError("unknown_session", "We could not find that session. Check the link or code.");
    return { title: meta.title };
  });

  // ---- participants -----------------------------------------------------------------------

  const tokenOf = (req: FastifyRequest) => String(req.headers["x-participant-token"] ?? "");
  const sidOf = (req: FastifyRequest) => {
    const sid = String((req.params as { sid?: string }).sid ?? "");
    if (!getBoardMeta(db, sid)) throw new VoteError("unknown_session", "We could not find that session. Check the link or code.");
    return sid;
  };

  app.post<{ Params: { sid: string } }>("/api/s/:sid/join", async (req) => {
    const sid = sidOf(req);
    const body = (req.body ?? {}) as { name?: string; token?: string };
    const result = join(db, sid, body.name ?? "", body.token);
    touch(db, sid, now());
    pushCounts(sid);
    hub.toFacilitators(sid, { type: "refresh" });
    return result;
  });

  app.get<{ Params: { sid: string } }>("/api/s/:sid/board", async (req) => {
    const sid = sidOf(req);
    reconcile(db, sid, now());
    const me = getParticipant(db, sid, tokenOf(req));
    return {
      serverNow: now(),
      board: getBoardMeta(db, sid),
      settings: getSettings(db, sid),
      columns: listColumns(db, sid),
      ideas: listIdeas(db, sid),
      me: me && { name: me.name, votes: getVotes(db, sid, me.token), ideasAdded: countIdeasBy(db, sid, me.token), submitted: !!me.submitted },
    };
  });

  app.put<{ Params: { sid: string; id: string }; Body: { starred?: boolean } }>("/api/s/:sid/votes/:id", async (req) => {
    const sid = sidOf(req);
    const token = tokenOf(req);
    const votes = setVote(db, sid, token, Number(req.params.id), req.body?.starred === true, now());
    hub.sendToToken(sid, token, { type: "votes", votes }); // keeps a second tab/device in step
    return { votes };
  });

  app.put<{ Params: { sid: string }; Body: { submitted?: boolean } }>("/api/s/:sid/submitted", async (req) => {
    const sid = sidOf(req);
    const token = tokenOf(req);
    const submitted = setSubmitted(db, sid, token, req.body?.submitted !== false, now());
    hub.sendToToken(sid, token, { type: "refresh" });
    pushCounts(sid);
    return { submitted };
  });

  app.post<{ Params: { sid: string }; Body: { title?: string; summary?: string } }>("/api/s/:sid/ideas", async (req) => {
    const sid = sidOf(req);
    const token = tokenOf(req);
    const idea = addIdea(db, sid, token, req.body ?? {}, now());
    hub.broadcast(sid, { type: "ideas", ideas: listIdeas(db, sid) });
    hub.toFacilitators(sid, { type: "refresh" });
    return { idea, ideasAdded: countIdeasBy(db, sid, token) };
  });

  // ---- facilitator (secret key in the x-admin-key header) ----------------------------------

  app.register(async (fac) => {
    fac.addHook("preHandler", async (req) => {
      const sid = String((req.params as { sid?: string }).sid ?? "");
      if (!verifyAdmin(db, sid, String(req.headers["x-admin-key"] ?? ""))) throw new VoteError("unauthorized", "This facilitator link is not valid.");
      touch(db, sid, now());
    });

    /** After any change, make every screen in the session refetch and re-arm the timer. */
    const changed = (sid: string) => {
      scheduleExpiry(sid);
      hub.refreshAll(sid);
    };

    type P = { Params: { sid: string } };
    type PI = { Params: { sid: string; id: string } };

    fac.get<P>("/api/s/:sid/admin/state", async (req) => {
      const sid = req.params.sid;
      reconcile(db, sid, now());
      // Headcounts only. What individuals picked is never returned here.
      return {
        serverNow: now(),
        board: getBoardMeta(db, sid),
        settings: getSettings(db, sid),
        columns: listColumns(db, sid),
        ideas: listIdeasForFacilitator(db, sid),
        counts: counts(sid),
      };
    });

    fac.put<P & { Body: { title?: string; subtitle?: string; bg?: string } }>("/api/s/:sid/admin/board", async (req) => {
      updateBoardMeta(db, req.params.sid, req.body ?? {});
      changed(req.params.sid);
      return { ok: true };
    });

    fac.put<P & { Body: Record<string, unknown> }>("/api/s/:sid/admin/settings", async (req) => {
      const b = req.body ?? {};
      updateSettings(db, req.params.sid, {
        votesPerPerson: b.votesPerPerson as number | undefined,
        ideasPerPerson: b.ideasPerPerson as number | undefined,
        ideasOpen: b.ideasOpen as boolean | undefined,
        namedResults: b.namedResults as boolean | undefined,
        autoLock: b.autoLock as boolean | undefined,
        timerSeconds: b.timerSeconds as number | null | undefined,
      });
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<P & { Body: { action?: Action; seconds?: number } }>("/api/s/:sid/admin/action", async (req) => {
      const action = req.body?.action;
      if (!action || !ACTIONS.includes(action)) throw new VoteError("bad_input", "Unknown action.");
      applyAction(db, req.params.sid, action, now(), req.body?.seconds);
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<P & { Body: { name?: string; description?: string; color?: string } }>("/api/s/:sid/admin/columns", async (req) => {
      const column = createColumn(db, req.params.sid, req.body ?? {});
      changed(req.params.sid);
      return { column };
    });

    fac.put<PI & { Body: { name?: string; description?: string; color?: string } }>("/api/s/:sid/admin/columns/:id", async (req) => {
      const column = updateColumn(db, req.params.sid, Number(req.params.id), req.body ?? {});
      changed(req.params.sid);
      return { column };
    });

    fac.delete<PI>("/api/s/:sid/admin/columns/:id", async (req) => {
      deleteColumn(db, req.params.sid, Number(req.params.id));
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<PI & { Body: { direction?: string } }>("/api/s/:sid/admin/columns/:id/move", async (req) => {
      moveColumn(db, req.params.sid, Number(req.params.id), req.body?.direction === "left" ? "left" : "right");
      changed(req.params.sid);
      return { ok: true };
    });

    type IdeaBody = { columnId?: number; title?: string; summary?: string; details?: string; audience?: string; code?: string };

    fac.post<P & { Body: IdeaBody }>("/api/s/:sid/admin/ideas", async (req) => {
      const idea = createIdea(db, req.params.sid, req.body ?? {});
      changed(req.params.sid);
      return { idea };
    });

    fac.put<PI & { Body: IdeaBody }>("/api/s/:sid/admin/ideas/:id", async (req) => {
      const idea = updateIdea(db, req.params.sid, Number(req.params.id), req.body ?? {});
      changed(req.params.sid);
      return { idea };
    });

    fac.delete<PI>("/api/s/:sid/admin/ideas/:id", async (req) => {
      deleteIdea(db, req.params.sid, Number(req.params.id));
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<P & { Body: { from?: number; into?: number } }>("/api/s/:sid/admin/ideas-merge", async (req) => {
      mergeIdeas(db, req.params.sid, Number(req.body?.from), Number(req.body?.into));
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<P & { Body: { format?: string; content?: string; mode?: string } }>("/api/s/:sid/admin/import", async (req) => {
      const { format, content, mode } = req.body ?? {};
      if ((format !== "csv" && format !== "json") || typeof content !== "string") throw new VoteError("bad_input", "Choose a CSV or JSON file.");
      const result = importBoard(db, req.params.sid, parseIdeas(format, content), mode === "replace" ? "replace" : "append");
      changed(req.params.sid);
      return result;
    });

    fac.get<P>("/api/s/:sid/admin/export", async (req) => exportBoard(db, req.params.sid));
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "index.ts");
if (isMain) {
  const db = openDb(process.env.DB_PATH ?? "data/brainstorm.db");
  const app = buildApp(db, { trustProxy: process.env.TRUST_PROXY === "1" });
  const dist = path.resolve(import.meta.dirname, "../dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    // Single-page app: /s/<code>, /f/<code> and other client routes serve index.html.
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: "not_found", message: "Not found." }),
    );
  }
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Brainstorm app listening on http://localhost:${port}`);
}
