import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { VoteError } from "./errors";
import { cleanIdeaFields, groupColumnId, MAX_IDEAS, type Idea } from "./ideas";
import { getSettings, reconcile } from "./session";

export { VoteError } from "./errors";
export type { VoteErrorCode } from "./errors";
export { getSettings, setSetting } from "./session";
export type { Settings } from "./session";

export const MAX_PARTICIPANTS = 300;

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
  if (n >= MAX_PARTICIPANTS) throw new VoteError("full", "This session is full.");

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

/** Star or un-star an idea. The server enforces phase, lock and cap; repeats are idempotent. */
export function setVote(db: DB, sid: string, token: string, ideaId: number, starred: boolean, now = Date.now()): number[] {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    if (!db.prepare("SELECT 1 FROM ideas WHERE id = ? AND session_id = ?").get(ideaId, sid)) throw new VoteError("unknown_idea", "That idea no longer exists.");
    const { votesPerPerson, phase } = getSettings(db, sid);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase !== "voting") throw new VoteError("locked", "Voting is locked.");

    const has = !!db.prepare("SELECT 1 FROM votes WHERE token = ? AND idea_id = ?").get(token, ideaId);
    if (starred && !has) {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE token = ?").get(token) as { n: number };
      if (n >= votesPerPerson) throw new VoteError("cap_reached", `You have used all ${votesPerPerson} stars. Un-star one first.`);
      db.prepare("INSERT INTO votes (token, idea_id) VALUES (?, ?)").run(token, ideaId);
    } else if (!starred && has) {
      db.prepare("DELETE FROM votes WHERE token = ? AND idea_id = ?").run(token, ideaId);
    }
    return getVotes(db, sid, token);
  })();
}

/** Mark "I'm done". Edits stay possible until the facilitator locks; this only feeds the facilitator's count. */
export function setSubmitted(db: DB, sid: string, token: string, submitted: boolean, now = Date.now()): boolean {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    const { phase } = getSettings(db, sid);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase !== "voting") throw new VoteError("locked", "Voting is locked.");
    if (submitted && getVotes(db, sid, token).length === 0) throw new VoteError("nothing_to_submit", "Star at least one idea before submitting.");
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

export function countIdeasBy(db: DB, sid: string, token: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ? AND author_token = ?").get(sid, token) as { n: number }).n;
}

/**
 * A participant suggests an idea (setup phase only). It lands in the board's group column. The author is
 * stored but never shown to participants.
 */
export function addIdea(db: DB, sid: string, token: string, input: { title?: string; summary?: string }, now = Date.now()): Idea {
  reconcile(db, sid, now);
  return db.transaction(() => {
    if (!getParticipant(db, sid, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    const { phase, ideasOpen, ideasPerPerson } = getSettings(db, sid);
    if (phase !== "setup" || !ideasOpen) throw new VoteError("ideas_closed", "New ideas are closed.");
    if (countIdeasBy(db, sid, token) >= ideasPerPerson) {
      throw new VoteError("idea_limit", `You have added the most ideas allowed (${ideasPerPerson}).`);
    }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(sid) as { n: number }).n;
    if (total >= MAX_IDEAS) throw new VoteError("full", "This board has reached its idea limit.");
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
