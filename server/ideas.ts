import type { DB } from "./db";
import { VoteError } from "./errors";
import { getSettings } from "./session";
import { cleanIdea, type Idea } from "./votes";

export const MAX_IDEAS = 300;

export interface FacilitatorIdea extends Idea {
  /** Name of the participant who suggested it, if any. Facilitator-only. */
  author: string | null;
}

export function listIdeasForFacilitator(db: DB): FacilitatorIdea[] {
  return db
    .prepare(
      `SELECT i.id, i.title, i.description, i.theme, p.name AS author
       FROM ideas i LEFT JOIN participants p ON p.token = i.author_token ORDER BY i.id`,
    )
    .all() as FacilitatorIdea[];
}

const count = (db: DB) => (db.prepare("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n;

export function createIdea(db: DB, input: { title?: string; description?: string; theme?: string }): Idea {
  return db.transaction(() => {
    if (count(db) >= MAX_IDEAS) throw new VoteError("bad_input", `A session can hold at most ${MAX_IDEAS} ideas.`);
    const idea = cleanIdea(db, input);
    const id = Number(db.prepare("INSERT INTO ideas (title, description, theme) VALUES (?, ?, ?)").run(idea.title, idea.description, idea.theme).lastInsertRowid);
    return { id, ...idea };
  })();
}

export function updateIdea(db: DB, id: number, input: { title?: string; description?: string; theme?: string }): Idea {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM ideas WHERE id = ?").get(id)) throw new VoteError("unknown_idea", "That idea no longer exists.");
    const idea = cleanIdea(db, input);
    db.prepare("UPDATE ideas SET title = ?, description = ?, theme = ? WHERE id = ?").run(idea.title, idea.description, idea.theme, id);
    return { id, ...idea };
  })();
}

/** Deleting an idea also removes the stars on it, which returns those stars to their owners. */
export function deleteIdea(db: DB, id: number) {
  if (db.prepare("DELETE FROM ideas WHERE id = ?").run(id).changes === 0) throw new VoteError("unknown_idea", "That idea no longer exists.");
}

/**
 * Fold one idea into another (for duplicates). Stars move to the target; anyone who starred both ends
 * up with one star, so nobody can exceed their cap.
 */
export function mergeIdeas(db: DB, fromId: number, intoId: number) {
  db.transaction(() => {
    if (fromId === intoId) throw new VoteError("bad_input", "Pick two different ideas to merge.");
    for (const id of [fromId, intoId]) {
      if (!db.prepare("SELECT 1 FROM ideas WHERE id = ?").get(id)) throw new VoteError("unknown_idea", "That idea no longer exists.");
    }
    db.prepare("INSERT OR IGNORE INTO votes (token, idea_id) SELECT token, ? FROM votes WHERE idea_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM ideas WHERE id = ?").run(fromId);
  })();
}

// ---- import -------------------------------------------------------------------------------

type Row = { title?: unknown; description?: unknown; theme?: unknown };

/** Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const ALIASES: Record<keyof Row, string[]> = {
  title: ["title", "idea", "name"],
  description: ["description", "desc", "details"],
  theme: ["theme", "category", "group"],
};

export function parseIdeas(format: "csv" | "json", content: string): Row[] {
  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new VoteError("bad_input", "That file is not valid JSON.");
    }
    const list = Array.isArray(data) ? data : (data as { ideas?: unknown })?.ideas;
    if (!Array.isArray(list)) throw new VoteError("bad_input", "Expected a JSON array of ideas (or an object with an \"ideas\" array).");
    return list.map((x) => (typeof x === "string" ? { title: x } : (x as Row)));
  }
  const [header, ...body] = parseCsv(content);
  if (!header) throw new VoteError("bad_input", "That CSV is empty.");
  const names = header.map((h) => h.trim().toLowerCase());
  const col = (key: keyof Row) => names.findIndex((n) => ALIASES[key].includes(n));
  const [t, d, th] = [col("title"), col("description"), col("theme")];
  if (t < 0) throw new VoteError("bad_input", "The CSV needs a header row with a \"title\" column (and optionally \"description\" and \"theme\").");
  return body.map((r) => ({ title: r[t], description: d >= 0 ? r[d] : "", theme: th >= 0 ? r[th] : "" }));
}

/** Import parsed rows. "replace" clears the board first and is only allowed before voting starts. */
export function importIdeas(db: DB, rows: Row[], mode: "append" | "replace") {
  return db.transaction(() => {
    if (mode === "replace") {
      if (getSettings(db).phase !== "setup") throw new VoteError("bad_state", "Ideas can only be replaced before voting starts.");
      db.prepare("DELETE FROM ideas").run();
    }
    let added = 0;
    let skipped = 0;
    for (const r of rows) {
      if (!String(r?.title ?? "").trim()) { skipped++; continue; }
      if (count(db) >= MAX_IDEAS) throw new VoteError("bad_input", `A session can hold at most ${MAX_IDEAS} ideas.`);
      const idea = cleanIdea(db, r);
      db.prepare("INSERT INTO ideas (title, description, theme) VALUES (?, ?, ?)").run(idea.title, idea.description, idea.theme);
      added++;
    }
    return { added, skipped };
  })();
}
