import type { DB } from "./db";
import { VoteError } from "./errors";
import { getSettings } from "./session";

export const MAX_IDEAS = 300;
export const MAX_COLUMNS = 20;

/** Starting colors for new columns. Facilitators can pick any color; these are just the defaults. */
export const PALETTE = ["#3b6fc4", "#e8833a", "#3fa56b", "#8a5cc7", "#d1568a", "#2a9d9f", "#c0504d", "#6b7280"];
export const GROUP_COLOR = "#d4a72c";

export interface Column {
  id: number;
  name: string;
  description: string;
  color: string;
  kind: "normal" | "group";
}

export interface Idea {
  id: number;
  columnId: number;
  code: string;
  audience: string;
  title: string;
  summary: string;
  details: string;
}

export interface FacilitatorIdea extends Idea {
  /** Name of the participant who suggested it, if any. Facilitator-only. */
  author: string | null;
}

const squash = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const paragraph = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

export function cleanColor(v: unknown, fallback?: string): string {
  const c = String(v ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (fallback) return fallback;
  throw new VoteError("bad_input", "Colors look like #3b6fc4.");
}

/** Trim and bound idea fields. */
export function cleanIdeaFields(input: { title?: unknown; summary?: unknown; details?: unknown; audience?: unknown; code?: unknown }) {
  const title = squash(input.title, 120);
  if (!title) throw new VoteError("invalid_idea", "Please enter a title.");
  return {
    title,
    summary: squash(input.summary, 400),
    details: paragraph(input.details, 2000),
    audience: squash(input.audience, 40),
    code: squash(input.code, 8),
  };
}

// ---- reading ------------------------------------------------------------------------------

export function listColumns(db: DB, sid: string): Column[] {
  return db
    .prepare("SELECT id, name, description, color, kind FROM columns WHERE session_id = ? ORDER BY (kind = 'group'), position, id")
    .all(sid) as Column[];
}

const IDEA_COLS = "id, column_id AS columnId, code, audience, title, summary, details";

export function listIdeas(db: DB, sid: string): Idea[] {
  return db.prepare(`SELECT ${IDEA_COLS} FROM ideas WHERE session_id = ? ORDER BY id`).all(sid) as Idea[];
}

export function listIdeasForFacilitator(db: DB, sid: string): FacilitatorIdea[] {
  return db
    .prepare(
      `SELECT i.id, i.column_id AS columnId, i.code, i.audience, i.title, i.summary, i.details, p.name AS author
       FROM ideas i LEFT JOIN participants p ON p.token = i.author_token WHERE i.session_id = ? ORDER BY i.id`,
    )
    .all(sid) as FacilitatorIdea[];
}

const ideaCount = (db: DB, sid: string) => (db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(sid) as { n: number }).n;

function getColumn(db: DB, sid: string, id: number): Column {
  const col = db.prepare("SELECT id, name, description, color, kind FROM columns WHERE id = ? AND session_id = ?").get(id, sid) as Column | undefined;
  if (!col) throw new VoteError("unknown_column", "That column no longer exists.");
  return col;
}

/** The column that holds participant-suggested ideas. Created with every session. */
export function groupColumnId(db: DB, sid: string): number {
  const row = db.prepare("SELECT id FROM columns WHERE session_id = ? AND kind = 'group'").get(sid) as { id: number } | undefined;
  if (!row) throw new VoteError("unknown_column", "This board has no group column.");
  return row.id;
}

// ---- columns ------------------------------------------------------------------------------

export function createGroupColumn(db: DB, sid: string) {
  db.prepare("INSERT INTO columns (session_id, name, description, color, position, kind) VALUES (?, ?, ?, ?, 9999, 'group')").run(
    sid, "Ideas from the group", "Add an idea that isn't on the board, then star it like any other.", GROUP_COLOR,
  );
}

export function createColumn(db: DB, sid: string, input: { name?: string; description?: string; color?: string }): Column {
  return db.transaction(() => {
    const normal = listColumns(db, sid).filter((c) => c.kind === "normal");
    if (normal.length >= MAX_COLUMNS) throw new VoteError("bad_input", `A board can have at most ${MAX_COLUMNS} columns.`);
    const name = squash(input.name, 60);
    if (!name) throw new VoteError("bad_input", "Please name the column.");
    const color = input.color === undefined || input.color === "" ? PALETTE[normal.length % PALETTE.length] : cleanColor(input.color);
    const description = squash(input.description, 200);
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM columns WHERE session_id = ? AND kind = 'normal'").get(sid) as { p: number }).p;
    const id = Number(
      db.prepare("INSERT INTO columns (session_id, name, description, color, position) VALUES (?, ?, ?, ?, ?)").run(sid, name, description, color, position)
        .lastInsertRowid,
    );
    return { id, name, description, color, kind: "normal" as const };
  })();
}

export function updateColumn(db: DB, sid: string, id: number, input: { name?: string; description?: string; color?: string }): Column {
  return db.transaction(() => {
    const col = getColumn(db, sid, id);
    const name = input.name === undefined ? col.name : squash(input.name, 60);
    if (!name) throw new VoteError("bad_input", "Please name the column.");
    const description = input.description === undefined ? col.description : squash(input.description, 200);
    const color = input.color === undefined ? col.color : cleanColor(input.color);
    db.prepare("UPDATE columns SET name = ?, description = ?, color = ? WHERE id = ?").run(name, description, color, id);
    return { ...col, name, description, color };
  })();
}

/** Deleting a column also deletes its ideas (and the stars on them). The group column cannot be deleted. */
export function deleteColumn(db: DB, sid: string, id: number) {
  db.transaction(() => {
    if (getColumn(db, sid, id).kind === "group") throw new VoteError("bad_state", "The group column can be renamed or recolored, but not deleted.");
    db.prepare("DELETE FROM columns WHERE id = ?").run(id);
  })();
}

export function moveColumn(db: DB, sid: string, id: number, direction: "left" | "right") {
  db.transaction(() => {
    const normal = listColumns(db, sid).filter((c) => c.kind === "normal");
    const i = normal.findIndex((c) => c.id === id);
    if (i < 0) throw new VoteError("unknown_column", "That column no longer exists.");
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= normal.length) return;
    [normal[i], normal[j]] = [normal[j], normal[i]];
    const set = db.prepare("UPDATE columns SET position = ? WHERE id = ?");
    normal.forEach((c, pos) => set.run(pos, c.id));
  })();
}

// ---- ideas --------------------------------------------------------------------------------

/** Short code for an idea, like S1 or T3: the column's first letter plus the next free number. */
function nextCode(db: DB, sid: string, columnName: string): string {
  const prefix = (columnName.match(/[A-Za-z]/)?.[0] ?? "I").toUpperCase();
  const used = new Set((db.prepare("SELECT code FROM ideas WHERE session_id = ?").all(sid) as { code: string }[]).map((r) => r.code));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

type IdeaInput = { columnId?: number; title?: string; summary?: string; details?: string; audience?: string; code?: string };

export function createIdea(db: DB, sid: string, input: IdeaInput): Idea {
  return db.transaction(() => {
    if (ideaCount(db, sid) >= MAX_IDEAS) throw new VoteError("bad_input", `A board can hold at most ${MAX_IDEAS} ideas.`);
    const col = getColumn(db, sid, Number(input.columnId));
    const f = cleanIdeaFields(input);
    const code = f.code || (col.kind === "normal" ? nextCode(db, sid, col.name) : "");
    const id = Number(
      db
        .prepare("INSERT INTO ideas (session_id, column_id, code, audience, title, summary, details) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sid, col.id, code, f.audience, f.title, f.summary, f.details).lastInsertRowid,
    );
    return { id, columnId: col.id, ...f, code };
  })();
}

export function updateIdea(db: DB, sid: string, id: number, input: IdeaInput): Idea {
  return db.transaction(() => {
    const cur = db.prepare(`SELECT ${IDEA_COLS} FROM ideas WHERE id = ? AND session_id = ?`).get(id, sid) as Idea | undefined;
    if (!cur) throw new VoteError("unknown_idea", "That idea no longer exists.");
    const columnId = input.columnId === undefined ? cur.columnId : getColumn(db, sid, Number(input.columnId)).id;
    const f = cleanIdeaFields({ ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    db.prepare("UPDATE ideas SET column_id = ?, code = ?, audience = ?, title = ?, summary = ?, details = ? WHERE id = ?").run(
      columnId, f.code, f.audience, f.title, f.summary, f.details, id,
    );
    return { id, columnId, ...f };
  })();
}

/** Deleting an idea also removes the stars on it, which returns those stars to their owners. */
export function deleteIdea(db: DB, sid: string, id: number) {
  if (db.prepare("DELETE FROM ideas WHERE id = ? AND session_id = ?").run(id, sid).changes === 0) {
    throw new VoteError("unknown_idea", "That idea no longer exists.");
  }
}

/**
 * Fold one idea into another (for duplicates). Stars move to the target; anyone who starred both ends
 * up with one star, so nobody can exceed their cap.
 */
export function mergeIdeas(db: DB, sid: string, fromId: number, intoId: number) {
  db.transaction(() => {
    if (fromId === intoId) throw new VoteError("bad_input", "Pick two different ideas to merge.");
    for (const id of [fromId, intoId]) {
      if (!db.prepare("SELECT 1 FROM ideas WHERE id = ? AND session_id = ?").get(id, sid)) throw new VoteError("unknown_idea", "That idea no longer exists.");
    }
    db.prepare("INSERT OR IGNORE INTO votes (token, idea_id) SELECT token, ? FROM votes WHERE idea_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM ideas WHERE id = ?").run(fromId);
  })();
}

// ---- import / export ----------------------------------------------------------------------

type ColRow = { name?: unknown; description?: unknown; color?: unknown };
type Row = { column?: unknown; title?: unknown; summary?: unknown; details?: unknown; audience?: unknown; code?: unknown };
export interface ParsedBoard {
  columns: ColRow[];
  ideas: Row[];
}

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
  column: ["column", "theme", "category", "group"],
  title: ["title", "idea", "name"],
  summary: ["summary", "description", "desc"],
  details: ["details", "detail", "long description"],
  audience: ["audience", "for"],
  code: ["code", "id"],
};

const asRow = (x: unknown): Row => {
  if (typeof x === "string") return { title: x };
  const o = (x ?? {}) as Record<string, unknown>;
  return {
    column: o.column ?? o.theme ?? o.category,
    title: o.title,
    summary: o.summary ?? o.description,
    details: o.details,
    audience: o.audience,
    code: o.code,
  };
};

export function parseIdeas(format: "csv" | "json", content: string): ParsedBoard {
  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new VoteError("bad_input", "That file is not valid JSON.");
    }
    const obj = (Array.isArray(data) ? { ideas: data } : data) as { columns?: unknown; ideas?: unknown };
    if (!obj || !Array.isArray(obj.ideas)) throw new VoteError("bad_input", 'Expected a JSON list of ideas, or an object with an "ideas" list (and optionally "columns").');
    return { columns: Array.isArray(obj.columns) ? (obj.columns as ColRow[]) : [], ideas: obj.ideas.map(asRow) };
  }
  const [header, ...body] = parseCsv(content);
  if (!header) throw new VoteError("bad_input", "That CSV is empty.");
  const names = header.map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries((Object.keys(ALIASES) as (keyof Row)[]).map((k) => [k, names.findIndex((n) => ALIASES[k].includes(n))])) as Record<keyof Row, number>;
  if (col.title < 0) throw new VoteError("bad_input", 'The CSV needs a header row with a "title" column. Optional columns: column, summary, details, audience, code.');
  const cell = (r: string[], k: keyof Row) => (col[k] >= 0 ? r[col[k]] : "");
  return {
    columns: [],
    ideas: body.map((r) => ({ column: cell(r, "column"), title: cell(r, "title"), summary: cell(r, "summary"), details: cell(r, "details"), audience: cell(r, "audience"), code: cell(r, "code") })),
  };
}

/**
 * Import columns and ideas. Columns are matched by name (case-insensitive) and created when missing.
 * "replace" clears the board first and is only allowed before voting starts. All-or-nothing.
 */
export function importBoard(db: DB, sid: string, parsed: ParsedBoard, mode: "append" | "replace") {
  return db.transaction(() => {
    if (mode === "replace") {
      if (getSettings(db, sid).phase !== "setup") throw new VoteError("bad_state", "The board can only be replaced before voting starts.");
      db.prepare("DELETE FROM ideas WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM columns WHERE session_id = ? AND kind = 'normal'").run(sid);
    }
    let columnsAdded = 0;
    const ensure = (name: string, extra: ColRow = {}): Column => {
      const key = name.toLowerCase();
      const found = listColumns(db, sid).find((c) => c.name.toLowerCase() === key);
      if (found) return found;
      columnsAdded++;
      return createColumn(db, sid, { name, description: extra.description as string, color: extra.color as string });
    };

    for (const c of parsed.columns) {
      const name = squash(c?.name, 60);
      if (name) ensure(name, c);
    }
    let added = 0;
    let skipped = 0;
    for (const r of parsed.ideas) {
      if (!String(r?.title ?? "").trim()) { skipped++; continue; }
      const col = ensure(squash(r.column, 60) || "General");
      createIdea(db, sid, { columnId: col.id, title: r.title as string, summary: r.summary as string, details: r.details as string, audience: r.audience as string, code: r.code as string });
      added++;
    }
    return { added, skipped, columnsAdded };
  })();
}

/** The board's structure and ideas, in the same shape the importer accepts. Never includes votes or people. */
export function exportBoard(db: DB, sid: string) {
  const columns = listColumns(db, sid).filter((c) => c.kind === "normal");
  const names = new Map(columns.map((c) => [c.id, c.name]));
  return {
    columns: columns.map((c) => ({ name: c.name, description: c.description, color: c.color })),
    ideas: listIdeas(db, sid)
      .filter((i) => names.has(i.columnId))
      .map((i) => ({ column: names.get(i.columnId), code: i.code, audience: i.audience, title: i.title, summary: i.summary, details: i.details })),
  };
}
