import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { openDb, type DB } from "./db";
import { createAuth, createThrottle } from "./auth";
import { HTTP_STATUS, VoteError } from "./errors";
import { Hub } from "./hub";
import {
  createIdea, deleteIdea, importIdeas, listIdeasForFacilitator, mergeIdeas, parseIdeas, updateIdea,
} from "./ideas";
import { applyAction, getSettings, reconcile, updateSettings, type Action } from "./session";
import {
  addIdea, countIdeasBy, getCounts, getParticipant, getVotes, insertIdeas, join, listIdeas, setSubmitted, setVote,
} from "./votes";

export interface AppOptions {
  /** Facilitator passcode. When missing, the facilitator view is disabled. */
  passcode?: string;
  now?: () => number;
  /** Set when running behind a hosting proxy so the real client IP (not the proxy's) is used for the passcode throttle. */
  trustProxy?: boolean;
}

const ACTIONS: Action[] = ["start", "pause", "resume", "extend", "lock", "reopen"];

export function buildApp(db: DB, opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  const auth = createAuth(opts.passcode, now);
  const throttle = createThrottle(5, 60_000, now);
  const hub = new Hub(app.server, db, auth.verify);

  const counts = () => ({ ...getCounts(db), connected: hub.connected() });
  const pushCounts = () => hub.toFacilitators({ type: "counts", ...counts() });
  hub.onPresence = pushCounts;

  // When a running timer reaches zero, mark it ended (and auto-lock if chosen), then tell everyone.
  let expiry: NodeJS.Timeout | undefined;
  const scheduleExpiry = () => {
    clearTimeout(expiry);
    const { timer } = getSettings(db);
    if (timer.state !== "running" || timer.endsAt === null) return;
    expiry = setTimeout(() => {
      if (reconcile(db, now())) hub.refreshAll();
      scheduleExpiry();
    }, Math.max(0, timer.endsAt - now()) + 20);
    expiry.unref();
  };
  scheduleExpiry();
  app.addHook("onClose", async () => {
    clearTimeout(expiry);
    hub.close();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof VoteError) return reply.code(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "bad_input", message: "That request was not valid." });
    return reply.code(500).send({ error: "server_error", message: "Something went wrong." });
  });

  // ---- participants -----------------------------------------------------------------------

  const tokenOf = (req: FastifyRequest) => String(req.headers["x-participant-token"] ?? "");

  app.post("/api/join", async (req) => {
    const body = (req.body ?? {}) as { name?: string; token?: string };
    const result = join(db, body.name ?? "", body.token);
    pushCounts();
    hub.toFacilitators({ type: "refresh" });
    return result;
  });

  app.get("/api/session", async (req) => {
    reconcile(db, now());
    const me = getParticipant(db, tokenOf(req));
    return {
      serverNow: now(),
      settings: getSettings(db),
      ideas: listIdeas(db),
      me: me && { name: me.name, votes: getVotes(db, me.token), ideasAdded: countIdeasBy(db, me.token), submitted: !!me.submitted },
    };
  });

  app.put<{ Params: { id: string }; Body: { starred?: boolean } }>("/api/votes/:id", async (req) => {
    const token = tokenOf(req);
    const votes = setVote(db, token, Number(req.params.id), req.body?.starred === true, now());
    hub.sendToToken(token, { type: "votes", votes }); // keeps a second tab/device in step
    return { votes };
  });

  app.put<{ Body: { submitted?: boolean } }>("/api/submitted", async (req) => {
    const token = tokenOf(req);
    const submitted = setSubmitted(db, token, req.body?.submitted !== false, now());
    hub.sendToToken(token, { type: "refresh" });
    pushCounts();
    return { submitted };
  });

  app.post<{ Body: { title?: string; description?: string; theme?: string } }>("/api/ideas", async (req) => {
    const token = tokenOf(req);
    const idea = addIdea(db, token, req.body ?? {}, now());
    hub.broadcast({ type: "ideas", ideas: listIdeas(db) });
    hub.toFacilitators({ type: "refresh" });
    return { idea, ideasAdded: countIdeasBy(db, token) };
  });

  // ---- facilitator ------------------------------------------------------------------------

  app.post<{ Body: { passcode?: string } }>("/api/facilitator/login", async (req) => {
    if (!auth.enabled) throw new VoteError("not_configured", "The facilitator view is not set up. Set FACILITATOR_PASSCODE on the server.");
    if (throttle.blocked(req.ip)) throw new VoteError("rate_limited", "Too many attempts. Wait a minute and try again.");
    const token = auth.login(String(req.body?.passcode ?? ""));
    if (!token) {
      throttle.fail(req.ip);
      throw new VoteError("unauthorized", "That passcode is not right.");
    }
    return { token };
  });

  // Everything under /api/facilitator (except login) needs a valid facilitator token.
  app.register(async (fac) => {
    fac.addHook("preHandler", async (req) => {
      if (!auth.verify(String(req.headers["x-facilitator-token"] ?? ""))) throw new VoteError("unauthorized", "Please sign in again.");
    });

    /** After any change, make every screen refetch and re-arm the timer. */
    const changed = () => {
      scheduleExpiry();
      hub.refreshAll();
    };

    fac.get("/api/facilitator/state", async () => {
      reconcile(db, now());
      // Headcounts only. What individuals picked is never returned here.
      return { serverNow: now(), settings: getSettings(db), ideas: listIdeasForFacilitator(db), counts: counts() };
    });

    fac.put<{ Body: Record<string, unknown> }>("/api/facilitator/settings", async (req) => {
      const b = req.body ?? {};
      updateSettings(db, {
        votesPerPerson: b.votesPerPerson as number | undefined,
        ideasPerPerson: b.ideasPerPerson as number | undefined,
        ideasOpen: b.ideasOpen as boolean | undefined,
        namedResults: b.namedResults as boolean | undefined,
        autoLock: b.autoLock as boolean | undefined,
        timerSeconds: b.timerSeconds as number | null | undefined,
      });
      changed();
      return { ok: true };
    });

    fac.post<{ Body: { action?: Action; seconds?: number } }>("/api/facilitator/action", async (req) => {
      const action = req.body?.action;
      if (!action || !ACTIONS.includes(action)) throw new VoteError("bad_input", "Unknown action.");
      applyAction(db, action, now(), req.body?.seconds);
      changed();
      return { ok: true };
    });

    fac.post<{ Body: { title?: string; description?: string; theme?: string } }>("/api/facilitator/ideas", async (req) => {
      const idea = createIdea(db, req.body ?? {});
      changed();
      return { idea };
    });

    fac.put<{ Params: { id: string }; Body: { title?: string; description?: string; theme?: string } }>("/api/facilitator/ideas/:id", async (req) => {
      const idea = updateIdea(db, Number(req.params.id), req.body ?? {});
      changed();
      return { idea };
    });

    fac.delete<{ Params: { id: string } }>("/api/facilitator/ideas/:id", async (req) => {
      deleteIdea(db, Number(req.params.id));
      changed();
      return { ok: true };
    });

    fac.post<{ Body: { from?: number; into?: number } }>("/api/facilitator/ideas/merge", async (req) => {
      mergeIdeas(db, Number(req.body?.from), Number(req.body?.into));
      changed();
      return { ok: true };
    });

    fac.post<{ Body: { format?: string; content?: string; mode?: string } }>("/api/facilitator/import", async (req) => {
      const { format, content, mode } = req.body ?? {};
      if ((format !== "csv" && format !== "json") || typeof content !== "string") throw new VoteError("bad_input", "Choose a CSV or JSON file.");
      const result = importIdeas(db, parseIdeas(format, content), mode === "replace" ? "replace" : "append");
      changed();
      return result;
    });
  });

  return app;
}

/** Development convenience only (SEED_EXAMPLE=1). A real session's ideas come from the facilitator. */
function seedExample(db: DB) {
  if (process.env.SEED_EXAMPLE !== "1" || listIdeas(db).length) return;
  insertIdeas(db, JSON.parse(fs.readFileSync("ideas.example.json", "utf8")));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "index.ts");
if (isMain) {
  const db = openDb(process.env.DB_PATH ?? "data/brainstorm.db");
  seedExample(db);
  let passcode = process.env.FACILITATOR_PASSCODE;
  if (passcode === "change-me") passcode = undefined; // never accept the placeholder from .env.example
  if (!passcode) console.warn("FACILITATOR_PASSCODE is not set: the facilitator view is disabled.");
  const app = buildApp(db, { passcode, trustProxy: process.env.TRUST_PROXY === "1" });
  const dist = path.resolve(import.meta.dirname, "../dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    // Single-page app: /facilitator and other client routes serve index.html.
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
