import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { VoteError } from "./errors";
import { getSettings, reconcile } from "./session";

export { VoteError } from "./errors";
export type { VoteErrorCode } from "./errors";
export { getSettings, setSetting } from "./session";
export type { Settings } from "./session";

export interface Idea {
  id: number;
  title: string;
  description: string;
  theme: string;
}

export function listIdeas(db: DB): Idea[] {
  return db.prepare("SELECT id, title, description, theme FROM ideas ORDER BY id").all() as Idea[];
}

export function insertIdeas(db: DB, ideas: { title: string; description?: string; theme?: string }[]) {
  const stmt = db.prepare("INSERT INTO ideas (title, description, theme) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const i of ideas) stmt.run(i.title, i.description ?? "", i.theme ?? "");
  })();
}

const squash = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/** Trim and bound idea fields; reuse an existing theme's spelling so "people" and "People" stay one group. */
export function cleanIdea(db: DB, input: { title?: unknown; description?: unknown; theme?: unknown }) {
  const title = squash(input.title, 120);
  if (!title) throw new VoteError("invalid_idea", "Please enter a title.");
  const description = squash(input.description, 400);
  let theme = squash(input.theme, 60);
  if (theme) {
    const match = db.prepare("SELECT theme FROM ideas WHERE lower(theme) = lower(?) LIMIT 1").get(theme) as { theme: string } | undefined;
    if (match) theme = match.theme;
  }
  return { title, description, theme };
}

/** Join with a name. A matching token resumes; a taken name without it is rejected. */
export function join(db: DB, name: string, token?: string | null): { token: string; name: string } {
  const clean = squash(name, 60);
  if (!clean) throw new VoteError("name_required", "Please enter your name.");
  const key = clean.toLowerCase();

  if (token) {
    const existing = getParticipant(db, token);
    if (existing) return existing;
  }
  const taken = db.prepare("SELECT 1 FROM participants WHERE name_key = ?").get(key);
  if (taken) throw new VoteError("name_taken", "That name is already in use. Add a last initial or similar.");

  const created = randomUUID();
  db.prepare("INSERT INTO participants (token, name, name_key) VALUES (?, ?, ?)").run(created, clean, key);
  return { token: created, name: clean };
}

export function getParticipant(db: DB, token: string | undefined | null) {
  if (!token) return null;
  return (
    (db.prepare("SELECT token, name, submitted FROM participants WHERE token = ?").get(token) as
      | { token: string; name: string; submitted: number }
      | undefined) ?? null
  );
}

export function getVotes(db: DB, token: string): number[] {
  return (db.prepare("SELECT idea_id FROM votes WHERE token = ? ORDER BY idea_id").all(token) as { idea_id: number }[]).map(
    (r) => r.idea_id,
  );
}

/** Star or un-star an idea. The server enforces phase, lock and cap; repeats are idempotent. */
export function setVote(db: DB, token: string, ideaId: number, starred: boolean, now = Date.now()): number[] {
  reconcile(db, now);
  return db.transaction(() => {
    if (!getParticipant(db, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    if (!db.prepare("SELECT 1 FROM ideas WHERE id = ?").get(ideaId)) throw new VoteError("unknown_idea", "That idea no longer exists.");
    const { votesPerPerson, phase } = getSettings(db);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase === "locked") throw new VoteError("locked", "Voting is locked.");

    const has = !!db.prepare("SELECT 1 FROM votes WHERE token = ? AND idea_id = ?").get(token, ideaId);
    if (starred && !has) {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE token = ?").get(token) as { n: number };
      if (n >= votesPerPerson) throw new VoteError("cap_reached", `You have used all ${votesPerPerson} stars. Un-star one first.`);
      db.prepare("INSERT INTO votes (token, idea_id) VALUES (?, ?)").run(token, ideaId);
    } else if (!starred && has) {
      db.prepare("DELETE FROM votes WHERE token = ? AND idea_id = ?").run(token, ideaId);
    }
    return getVotes(db, token);
  })();
}

/** Mark "I'm done". Edits stay possible until the facilitator locks; this only feeds the facilitator's count. */
export function setSubmitted(db: DB, token: string, submitted: boolean, now = Date.now()): boolean {
  reconcile(db, now);
  return db.transaction(() => {
    if (!getParticipant(db, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    const { phase } = getSettings(db);
    if (phase === "setup") throw new VoteError("not_started", "Voting has not started yet.");
    if (phase === "locked") throw new VoteError("locked", "Voting is locked.");
    if (submitted && getVotes(db, token).length === 0) throw new VoteError("nothing_to_submit", "Star at least one idea before submitting.");
    db.prepare("UPDATE participants SET submitted = ? WHERE token = ?").run(submitted ? 1 : 0, token);
    return submitted;
  })();
}

/** Headcounts only. Never what anyone picked. */
export function getCounts(db: DB) {
  const joined = (db.prepare("SELECT COUNT(*) AS n FROM participants").get() as { n: number }).n;
  const submitted = (db.prepare("SELECT COUNT(*) AS n FROM participants WHERE submitted = 1").get() as { n: number }).n;
  return { joined, submitted };
}

export function countIdeasBy(db: DB, token: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE author_token = ?").get(token) as { n: number }).n;
}

/** A participant suggests an idea (setup phase only). The author is stored but never shown to participants. */
export function addIdea(db: DB, token: string, input: { title?: string; description?: string; theme?: string }, now = Date.now()): Idea {
  reconcile(db, now);
  return db.transaction(() => {
    if (!getParticipant(db, token)) throw new VoteError("unknown_participant", "Please rejoin the session.");
    const { phase, ideasOpen, ideasPerPerson } = getSettings(db);
    if (phase !== "setup" || !ideasOpen) throw new VoteError("ideas_closed", "New ideas are closed.");
    if (countIdeasBy(db, token) >= ideasPerPerson) {
      throw new VoteError("idea_limit", `You have added the most ideas allowed (${ideasPerPerson}).`);
    }
    const idea = cleanIdea(db, input);
    const id = Number(
      db.prepare("INSERT INTO ideas (title, description, theme, author_token) VALUES (?, ?, ?, ?)").run(idea.title, idea.description, idea.theme, token)
        .lastInsertRowid,
    );
    return { id, ...idea };
  })();
}
