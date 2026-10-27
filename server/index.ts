import Fastify, { type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { defaultDbPath, openDb, type DB } from "./db";
import { createThrottle } from "./auth";
import { getResults, resultsToCsv } from "./results";
import { restoreResults } from "./restore";
import { HTTP_STATUS, VoteError } from "./errors";
import { Hub } from "./hub";
import { makeShutdown, withRetries } from "./lifecycle";
import { restoreIfNeeded, startSnapshots, type BackupStatus } from "./persist";
import { createS3, s3FromEnv } from "./s3";
import { registerStatic } from "./static";
import {
  createColumn, createIdea, deleteColumn, deleteIdea, exportBoard, importBoard, listColumns, listIdeas, listIdeasForFacilitator,
  mergeIdeas, moveColumn, parseIdeas, updateColumn, updateIdea,
} from "./ideas";
import { applyAction, getSettings, reconcile, updateSettings, type Action, type Method } from "./session";
import { createSession, deleteSession, getBoardMeta, getSummary, purgeIdle, sessionsWithDeadline, sessionsWithRunningTimer, touch, updateBoardMeta, verifyAdmin, type CreateInput } from "./sessions";
import { getLimits } from "./ballots";
import { addIdea, clearResponses, countIdeasBy, getBallot, getCounts, getParticipant, getPending, getPendingTokens, getVotes, join, listPeople, removalAllowed, removeParticipant, setBallot, setSubmitted, setVote } from "./votes";

export interface AppOptions {
  now?: () => number;
  /** Set when running behind a hosting proxy so the real client IP (not the proxy's) is used for rate limits. */
  trustProxy?: boolean;
  /** Reports how copies of the database are going, for the health check. Left out when backup is off. */
  backupStatus?: () => BackupStatus;
  /** Show a visible "this is a demo" notice on every page. For free hosting where polls can be erased. */
  demoNotice?: boolean;
  /** Polls created per client per hour. */
  createLimit?: number;
}

const ACTIONS: Action[] = ["start", "pause", "resume", "extend", "lock", "reopen", "reveal", "hide", "close"];
const IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export function buildApp(db: DB, opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  const createThrottled = createThrottle(opts.createLimit ?? 10, 60 * 60 * 1000, now);
  const hub = new Hub(app.server, db);

  const counts = (sid: string) => ({ ...getCounts(db, sid), connected: hub.connected(sid), pending: getPending(db, sid) });
  const lastReminder = new Map<string, number>();
  const pushCounts = (sid: string) => hub.toFacilitators(sid, { type: "counts", ...counts(sid) });
  hub.onPresence = pushCounts;

  // When a running timer reaches zero, or an open poll reaches its deadline, apply it and tell everyone in that
  // session. This is only a nudge for screens that are open: the stored times are also checked on every request,
  // so a poll still closes on time if the server slept or restarted. Long waits are re-armed in 12 hour steps.
  const expiry = new Map<string, NodeJS.Timeout>();
  const MAX_WAIT = 12 * 60 * 60 * 1000;
  const scheduleExpiry = (sid: string) => {
    clearTimeout(expiry.get(sid));
    expiry.delete(sid);
    const s = getSettings(db, sid);
    const due: number[] = [];
    if (s.timer.state === "running" && s.timer.endsAt !== null) due.push(s.timer.endsAt);
    if (s.mode === "poll" && s.phase === "voting" && s.deadline !== null) due.push(s.deadline);
    if (due.length === 0) return;
    const t = setTimeout(() => {
      if (reconcile(db, sid, now())) hub.refreshAll(sid);
      scheduleExpiry(sid);
    }, Math.min(MAX_WAIT, Math.max(0, Math.min(...due) - now()) + 20));
    t.unref();
    expiry.set(sid, t);
  };
  for (const sid of new Set([...sessionsWithRunningTimer(db), ...sessionsWithDeadline(db)])) scheduleExpiry(sid);

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

  // ---- health and settings the browser needs ---------------------------------------------------

  // For hosting health checks. It proves the database answers, and says nothing private.
  app.get("/api/health", async (_req, reply) => {
    try {
      db.prepare("SELECT 1 AS ok").get();
      // A problem saving copies does not make the site unhealthy (hosting would restart it), but it is reported.
      return { ok: true, storage: db.kind, uptimeSeconds: Math.round(process.uptime()), backup: opts.backupStatus?.() ?? { enabled: false } };
    } catch {
      return reply.code(503).send({ ok: false, storage: db.kind });
    }
  });

  // Whether to show the demo notice. Nothing else is exposed here.
  app.get("/api/config", async () => ({ demo: opts.demoNotice === true }));

  // ---- creating a poll -------------------------------------------------------------------

  app.post<{ Body: CreateInput }>("/api/sessions", async (req) => {
    if (createThrottled.blocked(req.ip)) throw new VoteError("rate_limited", "You have created a lot of polls recently. Please try again later.");
    const result = createSession(db, req.body ?? {}, now());
    createThrottled.record(req.ip);
    return result;
  });

  // Rebuild a poll from a results CSV that was downloaded earlier (hosting can forget polls).
  app.post<{ Body: { title?: string; csv?: string } }>("/api/sessions/restore", async (req) => {
    if (createThrottled.blocked(req.ip)) throw new VoteError("rate_limited", "You have created a lot of polls recently. Please try again later.");
    if (typeof req.body?.csv !== "string") throw new VoteError("bad_input", "Choose the results CSV to restore.");
    const result = restoreResults(db, { title: req.body.title, csv: req.body.csv }, now());
    createThrottled.record(req.ip);
    return result;
  });

  /** Looks up a session for the join screen without revealing anything private. */
  app.get<{ Params: { sid: string } }>("/api/s/:sid/exists", async (req) => {
    const meta = getBoardMeta(db, req.params.sid);
    if (!meta) throw new VoteError("unknown_session", "We could not find that poll. Check the link or code.");
    return { title: meta.title };
  });

  // ---- participants -----------------------------------------------------------------------

  const tokenOf = (req: FastifyRequest) => String(req.headers["x-participant-token"] ?? "");
  const sidOf = (req: FastifyRequest) => {
    const sid = String((req.params as { sid?: string }).sid ?? "");
    if (!getBoardMeta(db, sid)) throw new VoteError("unknown_session", "We could not find that poll. Check the link or code.");
    return sid;
  };

  app.post<{ Params: { sid: string } }>("/api/s/:sid/join", async (req) => {
    const sid = sidOf(req);
    const body = (req.body ?? {}) as { name?: string; token?: string };
    // Only a device type and a scrambled network code are kept from this, and only the organizer ever sees them.
    const result = join(db, sid, body.name ?? "", body.token, { now: now(), ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
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
      limits: getLimits(db, sid),
      me: me && {
        name: me.name,
        votes: getVotes(db, sid, me.token),
        /** Option id to value: 1 per dot, or a rank, score or points. Only this person's own ballot. */
        ballot: getBallot(db, sid, me.token),
        ideasAdded: countIdeasBy(db, sid, me.token),
        submitted: !!me.submitted,
      },
    };
  });

  app.put<{ Params: { sid: string; id: string }; Body: { starred?: boolean } }>("/api/s/:sid/votes/:id", async (req) => {
    const sid = sidOf(req);
    const token = tokenOf(req);
    const votes = setVote(db, sid, token, Number(req.params.id), req.body?.starred === true, now());
    hub.sendToToken(sid, token, { type: "votes", votes }); // keeps a second tab/device in step
    return { votes };
  });

  // Open polls only: once the poll has closed, and only if the organizer chose to share, anyone who joined can see the
  // results. They are always anonymous here, even when the organizer sees names.
  app.get<{ Params: { sid: string } }>("/api/s/:sid/results", async (req) => {
    const sid = sidOf(req);
    reconcile(db, sid, now());
    if (!getParticipant(db, sid, tokenOf(req))) throw new VoteError("unknown_participant", "Join the poll to see its results.");
    const s = getSettings(db, sid);
    if (s.mode !== "poll" || !s.shareResults || s.phase !== "revealed") throw new VoteError("bad_state", "The organizer has not shared the results.");
    return getResults(db, sid, { anonymous: true });
  });

  // Rank, score and points polls: the whole ballot is sent and checked at once. Dot polls use the route above.
  app.put<{ Params: { sid: string }; Body: { values?: unknown } }>("/api/s/:sid/ballot", async (req) => {
    const sid = sidOf(req);
    const token = tokenOf(req);
    const result = setBallot(db, sid, token, req.body?.values ?? {}, now());
    touch(db, sid, now());
    hub.sendToToken(sid, token, { type: "votes", votes: result.votes, ballot: result.ballot }); // keeps a second tab/device in step
    pushCounts(sid);
    return result;
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

  // ---- organizer (secret key in the x-admin-key header) ----------------------------------

  app.register(async (fac) => {
    fac.addHook("preHandler", async (req) => {
      const sid = String((req.params as { sid?: string }).sid ?? "");
      if (!verifyAdmin(db, sid, String(req.headers["x-admin-key"] ?? ""))) throw new VoteError("unauthorized", "This organizer link is not valid.");
      touch(db, sid, now());
    });

    /** After any change, make every screen in the session refetch and re-arm the timer. */
    const changed = (sid: string) => {
      scheduleExpiry(sid);
      hub.refreshAll(sid);
    };

    type P = { Params: { sid: string } };
    type PI = { Params: { sid: string; id: string } };

    // Nudge everyone who has not submitted. Names only go to the organizer; participants just see a prompt.
    fac.post<P>("/api/s/:sid/admin/remind", async (req) => {
      const sid = req.params.sid;
      reconcile(db, sid, now());
      if (getSettings(db, sid).phase !== "voting") throw new VoteError("bad_state", "Reminders can only be sent while voting is open.");
      const last = lastReminder.get(sid) ?? 0;
      if (now() - last < 10_000) throw new VoteError("rate_limited", "You just sent a reminder. Give people a few seconds.");
      lastReminder.set(sid, now());
      const tokens = getPendingTokens(db, sid);
      for (const t of tokens) hub.sendToToken(sid, t, { type: "nudge" });
      return { reminded: tokens.length };
    });

    fac.get<P>("/api/s/:sid/admin/summary", async (req) => getSummary(db, req.params.sid));

    // Test votes: see who joined (names and whether they submitted, never picks), remove one person, or clear everything.
    fac.get<P>("/api/s/:sid/admin/people", async (req) => ({ people: listPeople(db, req.params.sid), ...removalAllowed(db, req.params.sid) }));

    fac.post<P & { Body: { name?: string } }>("/api/s/:sid/admin/people/remove", async (req) => {
      const sid = req.params.sid;
      removeParticipant(db, sid, String(req.body?.name ?? ""));
      pushCounts(sid);
      changed(sid); // anyone with the poll open is asked to join again
      return { ok: true };
    });

    fac.post<P>("/api/s/:sid/admin/responses/clear", async (req) => {
      const sid = req.params.sid;
      const removed = clearResponses(db, sid);
      pushCounts(sid);
      changed(sid);
      return { removed };
    });

    fac.delete<P>("/api/s/:sid/admin", async (req) => {
      const sid = req.params.sid;
      deleteSession(db, sid);
      clearTimeout(expiry.get(sid));
      expiry.delete(sid);
      hub.closeSession(sid);
      return { ok: true };
    });

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
        limits: getLimits(db, sid),
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
        method: b.method as Method | undefined,
        votesPerPerson: b.votesPerPerson as number | undefined,
        ideasPerPerson: b.ideasPerPerson as number | undefined,
        ideasOpen: b.ideasOpen as boolean | undefined,
        namedResults: b.namedResults as boolean | undefined,
        autoLock: b.autoLock as boolean | undefined,
        timerSeconds: b.timerSeconds as number | null | undefined,
        deadline: b.deadline as number | null | undefined,
        shareResults: b.shareResults as boolean | undefined,
      }, now());
      changed(req.params.sid);
      return { ok: true };
    });

    fac.post<P & { Body: { action?: Action; seconds?: number; deadline?: number | null } }>("/api/s/:sid/admin/action", async (req) => {
      const action = req.body?.action;
      if (!action || !ACTIONS.includes(action)) throw new VoteError("bad_input", "Unknown action.");
      applyAction(db, req.params.sid, action, now(), req.body?.seconds, req.body && "deadline" in req.body ? { deadline: req.body.deadline } : {});
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

    // Results exist only after the organizer reveals them (getResults enforces this).
    fac.get<P>("/api/s/:sid/admin/results", async (req) => getResults(db, req.params.sid));

    fac.get<P>("/api/s/:sid/admin/results.csv", async (req, reply) => {
      const csv = resultsToCsv(getResults(db, req.params.sid));
      return reply.header("content-type", "text/csv; charset=utf-8").header("cache-control", "no-store").send(csv);
    });
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "index.ts");
if (isMain) {
  const log = (m: string) => console.log(`[ority] ${m}`);
  const file = defaultDbPath(process.env.DB_PATH);

  // Optional: keep polls across restarts by saving copies to a private bucket (see docs/HOSTING.md).
  const s3Config = s3FromEnv();
  const s3 = s3Config ? createS3(s3Config) : null;
  const prefix = process.env.BACKUP_PREFIX ?? "ority/";
  if (s3) {
    // If the bucket cannot be reached, stop rather than start empty and later overwrite the saved copy.
    await withRetries("Checking the saved copy", () => restoreIfNeeded({ file, s3, prefix, log }), { log }).catch((e) => {
      console.error(`[ority] Cannot reach the backup bucket, so not starting (the saved copy is untouched): ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
  } else {
    log("Backup is off. Polls are lost if the disk is erased. See docs/HOSTING.md to keep them for free.");
  }

  const db = openDb(file, process.env.STORAGE ?? "sqlite");
  const snapshots = s3 ? startSnapshots({ db, s3, prefix, log, intervalMs: Math.max(5, Number(process.env.BACKUP_INTERVAL_SECONDS ?? 60)) * 1000 }) : null;
  const app = buildApp(db, { trustProxy: process.env.TRUST_PROXY === "1", demoNotice: process.env.DEMO_NOTICE === "1", backupStatus: snapshots?.status });

  const shutdown = makeShutdown({ app, db, snapshots, log, exit: (code) => process.exit(code) });
  process.on("SIGTERM", () => void shutdown("Told to stop (SIGTERM)"));
  process.on("SIGINT", () => void shutdown("Interrupted (SIGINT)"));
  const dist = path.resolve(import.meta.dirname, "../dist");
  if (fs.existsSync(dist)) await registerStatic(app, dist);
  const port = Number(process.env.PORT ?? 3000);
  // A longer queue for new connections, so a crowd that arrives at once is not turned away.
  await app.listen({ port, host: "0.0.0.0", backlog: 1024 });
  console.log(`Ority listening on http://localhost:${port} (storage: ${db.kind}, ${db.location}, backup: ${snapshots ? "on" : "off"})`);
}
