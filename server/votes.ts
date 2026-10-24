import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { VoteError } from "./errors";
import { ballotRows, getLimits, incompleteMessage, isComplete, validateBallot, type BallotRow } from "./ballots";
import { cleanIdeaFields, groupColumnId, MAX_IDEAS, type Idea } from "./ideas";
import { getSettings, reconcile } from "./session";

export { VoteError } from "./errors";
export type { VoteErrorCode } from "./errors";
export { getSettings, setSetting } from "./session";
export type { Settings } from "./session";

export const MAX_PARTICIPANTS = 300;

/** What to say when someone tries to vote after voting has closed. */
const lockedMessage = (db: DB, sid: string) => (getSettings(db, sid).mode === "poll" ? "This poll has closed." : "Voting is locked.");

const squash = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/** Join with a name. A matching token resumes; a taken name without it is rejected. */
export function join(db: DB, sid: string, name: string, token?: string | null): { token: string; name: string } {
  const clean = squash(name, 60);
  if (!clean) throw new VoteError("name_required", "Please enter your name.");
  const key = clean.toLowerCase();

  if (token) {
    const existing = getParticipant(db, sid, token);
    if (existing) return existing;
  }
  const taken = db.prepare("SELECT 1 FROM participants WHERE session_id = ? AND name_key = ?").get(sid, key);
  if (taken) throw new VoteError("name_taken", "That name is already in use. Add a last initial or similar.");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM participants WHERE session_id = ?").get(sid) as { n: number }).n;
  if (n >= MAX_PARTICIPANTS) throw new VoteError("full", "This poll is full.");

  const created = randomUUID();
  db.prepare("INSERT INTO participants (token, session_id, name, name_key) VALUES (?, ?, ?, ?)").run(created, sid, clean, key);
  return { token: created, name: clean };
}

export function getParticipant(db: DB, sid: string, token: string | undefined | null) {
  if (!token) return null;
  return (
    (db.prepare("SELECT token, name, submitted FROM participants WHERE token = ? AND session_id = ?").get(token, sid) as
      | { token: string; name: string; submitted: number }
      | undefined) ?? null
  );
}

export function getVotes(db: DB, sid: string, token: string): number[] {
  return (
    db
      .prepare("SELECT v.idea_id FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE v.token = ? AND i.session_id = ? ORDER BY v.idea_id")
      .all(token, sid) as { idea_id: number }[]
  ).map((r) => r.idea_id);
}

/** Vote or un-vote for an option (dot voting). The server enforces phase, lock and cap; repeats are idempotent. */
export function setVote(db: DB, sid: string, token: string, ideaId: number, starred: boolean, now = Date.now()): number[] {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the poll.");
    if (!db.prepare("SELECT 1 FROM ideas WHERE id = ? AND session_id = ?").get(ideaId, sid)) throw new VoteError("unknown_idea", "That option no longer exists.");
    const { votesPerPerson, phase, method } = getSettings(db, sid);
    if (method !== "dots") throw new VoteError("bad_state", "This poll does not use dot voting.");
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase !== "voting") throw new VoteError("locked", lockedMessage(db, sid));

    const has = !!db.prepare("SELECT 1 FROM votes WHERE token = ? AND idea_id = ?").get(token, ideaId);
    if (starred && !has) {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE token = ?").get(token) as { n: number };
      if (n >= votesPerPerson) throw new VoteError("cap_reached", `You have used all ${votesPerPerson} votes. Remove one first.`);
      db.prepare("INSERT INTO votes (token, idea_id) VALUES (?, ?)").run(token, ideaId);
    } else if (!starred && has) {
      db.prepare("DELETE FROM votes WHERE token = ? AND idea_id = ?").run(token, ideaId);
    }
    return getVotes(db, sid, token);
  })();
}

/** One person's ballot as a map from option id to value (1 per dot, or a rank, score or points). */
export function getBallot(db: DB, sid: string, token: string): Record<number, number> {
  return Object.fromEntries(ballotRows(db, sid, token).map((r: BallotRow) => [r.ideaId, r.value]));
}

/**
 * Replace a person's whole ballot (rank, score and points polls). The server checks the method's rules, the phase
 * and that every option belongs to this poll. An empty ballot clears it. If an edit leaves a submitted ballot
 * unfinished, the "submitted" mark is removed so the organizer's count stays honest.
 */
export function setBallot(db: DB, sid: string, token: string, values: unknown, now = Date.now()) {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the poll.");
    const { phase, method } = getSettings(db, sid);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase !== "voting") throw new VoteError("locked", lockedMessage(db, sid));
    const limits = getLimits(db, sid);
    const rows = validateBallot(method, values, limits);

    const own = db.prepare("SELECT 1 FROM ideas WHERE id = ? AND session_id = ?");
    for (const r of rows) if (!own.get(r.ideaId, sid)) throw new VoteError("unknown_idea", "That option no longer exists.");

    db.prepare("DELETE FROM votes WHERE token = ? AND idea_id IN (SELECT id FROM ideas WHERE session_id = ?)").run(token, sid);
    const insert = db.prepare("INSERT INTO votes (token, idea_id, value) VALUES (?, ?, ?)");
    for (const r of rows) insert.run(token, r.ideaId, r.value);

    let submitted = !!(db.prepare("SELECT submitted FROM participants WHERE token = ?").get(token) as { submitted: number }).submitted;
    if (submitted && !isComplete(method, rows, limits)) {
      db.prepare("UPDATE participants SET submitted = 0 WHERE token = ?").run(token);
      submitted = false;
    }
    return { votes: getVotes(db, sid, token), ballot: getBallot(db, sid, token), submitted };
  })();
}

/** Mark "I'm done". Edits stay possible until the organizer locks; this only feeds the organizer's count. */
export function setSubmitted(db: DB, sid: string, token: string, submitted: boolean, now = Date.now()): boolean {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the poll.");
    const { phase, method } = getSettings(db, sid);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase !== "voting") throw new VoteError("locked", lockedMessage(db, sid));
    const limits = getLimits(db, sid);
    if (submitted && !isComplete(method, ballotRows(db, sid, token), limits)) throw new VoteError("nothing_to_submit", incompleteMessage(method, limits));
    db.prepare("UPDATE participants SET submitted = ? WHERE token = ?").run(submitted ? 1 : 0, token);
    return submitted;
  })();
}

/** Headcounts only. Never what anyone picked. */
export function getCounts(db: DB, sid: string) {
  const joined = (db.prepare("SELECT COUNT(*) AS n FROM participants WHERE session_id = ?").get(sid) as { n: number }).n;
  const submitted = (db.prepare("SELECT COUNT(*) AS n FROM participants WHERE session_id = ? AND submitted = 1").get(sid) as { n: number }).n;
  return { joined, submitted };
}

/** Names of participants who have not pressed Submit. Names only, never what anyone picked. */
export function getPending(db: DB, sid: string): string[] {
  return (db.prepare("SELECT name FROM participants WHERE session_id = ? AND submitted = 0 ORDER BY name COLLATE NOCASE").all(sid) as { name: string }[]).map((r) => r.name);
}

export function getPendingTokens(db: DB, sid: string): string[] {
  return (db.prepare("SELECT token FROM participants WHERE session_id = ? AND submitted = 0").all(sid) as { token: string }[]).map((r) => r.token);
}

export function countIdeasBy(db: DB, sid: string, token: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ? AND author_token = ?").get(sid, token) as { n: number }).n;
}

/**
 * A participant suggests an option (setup phase only). It lands in the poll's ungrouped section. The author is
 * stored but never shown to participants.
 */
export function addIdea(db: DB, sid: string, token: string, input: { title?: string; summary?: string }, now = Date.now()): Idea {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the poll.");
    const { phase, ideasOpen, ideasPerPerson } = getSettings(db, sid);
    if (phase !== "setup" || !ideasOpen) throw new VoteError("ideas_closed", "New options are closed.");
    if (countIdeasBy(db, sid, token) >= ideasPerPerson) {
      throw new VoteError("idea_limit", `You have added the most options allowed (${ideasPerPerson}).`);
    }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(sid) as { n: number }).n;
    if (total >= MAX_IDEAS) throw new VoteError("full", "This poll has reached its option limit.");
    const f = cleanIdeaFields({ title: input.title, summary: input.summary });
    const columnId = groupColumnId(db, sid);
    const id = Number(
      db
        .prepare("INSERT INTO ideas (session_id, column_id, code, audience, title, summary, details, author_token) VALUES (?, ?, '', '', ?, ?, '', ?)")
        .run(sid, columnId, f.title, f.summary, token).lastInsertRowid,
    );
    return { id, columnId, code: "", audience: "", title: f.title, summary: f.summary, details: "" };
  })();
}
