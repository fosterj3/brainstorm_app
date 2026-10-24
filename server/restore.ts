import type { DB } from "./db";
import { VoteError } from "./errors";
import { createColumn, groupColumnId, listColumns, MAX_COLUMNS, MAX_IDEAS, parseCsv } from "./ideas";
import { setSetting } from "./session";
import { createSession } from "./sessions";

export interface RestoredRow {
  title: string;
  column: string;
  code: string;
  audience: string;
  stars: number;
  voters: string[];
}

const ALIASES = {
  title: ["option", "idea", "title", "name"],
  stars: ["votes", "points", "borda points", "stars"],
  column: ["column", "theme", "category", "group"],
  code: ["code", "id"],
  audience: ["tag", "audience"],
  voters: ["voted by", "starred by", "voters"],
} as const;

const squash = (v: string, max: number) => v.trim().replace(/\s+/g, " ").slice(0, max);
/** The export prefixes cells that start with = + - or @ with an apostrophe so spreadsheets don't run them; undo that. */
const unescape = (v: string) => v.replace(/^'(?=[=+\-@\t\r])/, "");

/** Read a results CSV (the file the app downloads from the Results tab). Old and new header names both work. */
export function parseResultsCsv(text: string): { rows: RestoredRow[]; named: boolean; skipped: number } {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new VoteError("bad_input", "That file is empty.");
  const names = header.map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(
    (Object.keys(ALIASES) as (keyof typeof ALIASES)[]).map((k) => [k, names.findIndex((n) => (ALIASES[k] as readonly string[]).includes(n))]),
  ) as Record<keyof typeof ALIASES, number>;
  if (col.title < 0 || col.stars < 0) {
    throw new VoteError("bad_input", 'This does not look like a results file. It needs "Option" and "Votes" columns (older files use "Idea" and "Stars"), like the CSV downloaded from the Results tab.');
  }
  const cell = (r: string[], key: keyof typeof ALIASES) => (col[key] < 0 ? "" : r[col[key]] ?? "");

  const rows: RestoredRow[] = [];
  let skipped = 0;
  body.forEach((r, i) => {
    const title = squash(unescape(cell(r, "title")), 120);
    if (!title) {
      skipped++;
      return;
    }
    const rawStars = cell(r, "stars").trim();
    const stars = Number(rawStars);
    if (rawStars === "" || !Number.isInteger(stars) || stars < 0 || stars > 100_000) {
      throw new VoteError("bad_input", `Row ${i + 2} ("${title.slice(0, 30)}"): Votes must be a whole number.`);
    }
    rows.push({
      title,
      stars,
      column: squash(unescape(cell(r, "column")), 60),
      code: squash(unescape(cell(r, "code")), 8),
      audience: squash(unescape(cell(r, "audience")), 40),
      voters: cell(r, "voters").split(";").map((n) => squash(n, 60)).filter(Boolean).slice(0, 300),
    });
  });
  if (rows.length === 0) throw new VoteError("bad_input", "That file has no options in it.");
  if (rows.length > MAX_IDEAS) throw new VoteError("bad_input", `A poll can hold at most ${MAX_IDEAS} options.`);
  return { rows, named: col.voters >= 0 && rows.some((r) => r.voters.length > 0), skipped };
}

/**
 * Rebuild a poll from a results CSV: the options, their groups, and each option's vote count (and the names, when the
 * file has them). The new poll opens with the results showing. Rankings are recomputed from the votes.
 */
export function restoreResults(db: DB, input: { title?: string; csv: string }, now = Date.now()) {
  const parsed = parseResultsCsv(input.csv); // validate before creating anything
  return db.transaction(() => {
    const { id, adminKey } = createSession(db, { title: input.title }, now);
    // A blank group goes in the ungrouped section.
    const ensureColumn = (name: string) => {
      if (!name) return groupColumnId(db, id);
      const wanted = name.toLowerCase();
      const found = listColumns(db, id).find((c) => c.name.toLowerCase() === wanted);
      if (found) return found.id;
      if (listColumns(db, id).filter((c) => c.kind === "normal").length >= MAX_COLUMNS) {
        throw new VoteError("bad_input", `A poll can have at most ${MAX_COLUMNS} groups.`);
      }
      return createColumn(db, id, { name }).id;
    };
    const insert = db.prepare(
      "INSERT INTO ideas (session_id, column_id, code, audience, title, summary, details, restored_stars, restored_voters) VALUES (?, ?, ?, ?, ?, '', '', ?, ?)",
    );
    for (const r of parsed.rows) {
      insert.run(id, ensureColumn(r.column), r.code, r.audience, r.title, r.stars, r.voters.length ? JSON.stringify(r.voters) : null);
    }
    setSetting(db, id, "named_results", parsed.named);
    setSetting(db, id, "restored", true);
    setSetting(db, id, "phase", "revealed");
    return { id, adminKey, ideas: parsed.rows.length, skipped: parsed.skipped, named: parsed.named };
  })();
}
