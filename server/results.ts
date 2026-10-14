import type { DB } from "./db";
import { VoteError } from "./errors";
import { getSettings } from "./session";

export interface ResultRow {
  id: number;
  column: string;
  columnId: number;
  code: string;
  audience: string;
  title: string;
  summary: string;
  stars: number;
  /** Competition rank: ideas with equal stars share a rank, and the next rank skips (1, 2, 2, 4). */
  rank: number;
  tied: boolean;
  /** Names of the people who starred it. Only present when the facilitator chose named results. */
  voters?: string[];
}

export interface Results {
  named: boolean;
  /** True for a board rebuilt from an uploaded results CSV: participation counts are not known. */
  restored: boolean;
  totals: { joined: number; submitted: number; voted: number; stars: number };
  rows: ResultRow[];
}

/**
 * Tally the stars. Only available once the facilitator has revealed results, so it can never be read
 * (even by the facilitator) while voting is still open.
 */
export function getResults(db: DB, sid: string): Results {
  const { phase, namedResults } = getSettings(db, sid);
  if (phase !== "revealed") throw new VoteError("bad_state", "Lock voting and reveal the results first.");

  const rows = db
    .prepare(
      `SELECT i.id, i.column_id AS columnId, c.name AS column, i.code, i.audience, i.title, i.summary,
              (SELECT COUNT(*) FROM votes v WHERE v.idea_id = i.id) + i.restored_stars AS stars,
              i.restored_voters AS restoredVoters
       FROM ideas i JOIN columns c ON c.id = i.column_id
       WHERE i.session_id = ?
       ORDER BY stars DESC, (c.kind = 'group'), c.position, i.id`,
    )
    .all(sid) as (Omit<ResultRow, "rank" | "tied" | "voters"> & { restoredVoters: string | null })[];

  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.stars, (counts.get(r.stars) ?? 0) + 1);

  const voters = new Map<number, string[]>();
  if (namedResults) {
    const named = db
      .prepare(
        `SELECT v.idea_id AS id, p.name FROM votes v
         JOIN participants p ON p.token = v.token WHERE p.session_id = ? ORDER BY p.name COLLATE NOCASE`,
      )
      .all(sid) as { id: number; name: string }[];
    for (const n of named) voters.set(n.id, [...(voters.get(n.id) ?? []), n.name]);
    for (const r of rows) {
      if (!r.restoredVoters) continue;
      const merged = new Set([...(voters.get(r.id) ?? []), ...(JSON.parse(r.restoredVoters) as string[])]);
      voters.set(r.id, [...merged].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    }
  }

  let rank = 0;
  let prevStars = -1;
  const ranked: ResultRow[] = rows.map((r, i) => {
    if (r.stars !== prevStars) rank = i + 1;
    prevStars = r.stars;
    const { restoredVoters: _ignored, ...base } = r;
    const row: ResultRow = { ...base, rank, tied: (counts.get(r.stars) ?? 0) > 1 };
    if (namedResults) row.voters = voters.get(r.id) ?? [];
    return row;
  });

  const one = (sql: string) => (db.prepare(sql).get(sid) as { n: number }).n;
  return {
    named: namedResults,
    restored: (db.prepare("SELECT value FROM settings WHERE session_id = ? AND key = 'restored'").get(sid) as { value: string } | undefined)?.value === "1",
    totals: {
      joined: one("SELECT COUNT(*) AS n FROM participants WHERE session_id = ?"),
      submitted: one("SELECT COUNT(*) AS n FROM participants WHERE session_id = ? AND submitted = 1"),
      voted: one("SELECT COUNT(DISTINCT v.token) AS n FROM votes v JOIN participants p ON p.token = v.token WHERE p.session_id = ?"),
      stars: ranked.reduce((sum, r) => sum + r.stars, 0),
    },
    rows: ranked,
  };
}

/** Spreadsheets run text that starts with = + - or @ as a formula; neutralise it, since titles come from participants. */
const cell = (value: string | number) => {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function resultsToCsv(results: Results): string {
  const header = ["Rank", "Tied", "Code", "Idea", "Column", "Audience", "Stars", ...(results.named ? ["Starred by"] : [])];
  const lines = [header, ...results.rows.map((r) => [
    r.rank, r.tied ? "yes" : "", r.code, r.title, r.column, r.audience, r.stars, ...(results.named ? [(r.voters ?? []).join("; ")] : []),
  ])];
  return "\uFEFF" + lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
}
