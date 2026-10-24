import { compactRanks, getLimits } from "./ballots";
import type { DB } from "./db";
import { VoteError } from "./errors";
import { getSettings, type Method } from "./session";

export interface ResultRow {
  id: number;
  column: string;
  /** False for options in the ungrouped section, so exports and screens can leave the group blank. */
  grouped: boolean;
  columnId: number;
  code: string;
  audience: string;
  title: string;
  summary: string;
  /**
   * The option's score under the poll's method: votes (dots), points ($100 method), Borda points (rank order),
   * or the average score from 1 to 5 (score). The field keeps its old name so saved files and clients still work.
   */
  stars: number;
  /** How many people gave this option a vote, rank, score or points. For score polls this is the number of ratings. */
  ratings: number;
  /** Competition rank: options with equal scores share a rank, and the next rank skips (1, 2, 2, 4). */
  rank: number;
  tied: boolean;
  /** Who voted for it. Only present when the organizer chose named results. Rank, score and points polls add the value. */
  voters?: string[];
}

export interface Results {
  method: Method;
  named: boolean;
  /** True for a poll rebuilt from an uploaded results CSV: participation counts are not known. */
  restored: boolean;
  /** `stars` is the sum of the row scores, except in score polls where it is the number of ratings. */
  totals: { joined: number; submitted: number; voted: number; stars: number };
  rows: ResultRow[];
}

type Base = Omit<ResultRow, "rank" | "tied" | "voters" | "stars" | "ratings" | "grouped"> & {
  grouped: number;
  kind: string;
  pos: number;
  restoredStars: number;
  restoredVoters: string | null;
};
type Vote = { token: string; ideaId: number; value: number; name: string };
/** A score as an exact fraction, so averages compare without rounding errors. d = 0 means "no data yet". */
type Score = { n: number; d: number; count: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tally the ballots for the poll's method. Only available once the organizer has revealed results, so it can
 * never be read (even by the organizer) while voting is still open.
 *
 * - dots: the number of votes (plus any restored from a CSV).
 * - points: the sum of the points people gave.
 * - rank: Borda count. With K ranking slots, 1st place earns K points, 2nd K-1, down to 1. Unranked earns 0.
 * - score: the average of the 1 to 5 scores, with ties broken by how many people rated the option.
 */
export function getResults(db: DB, sid: string, opts: { anonymous?: boolean } = {}): Results {
  const { phase, namedResults: organizerNamed, method } = getSettings(db, sid);
  // People other than the organizer never see who voted for what, even if the organizer chose named results.
  const namedResults = organizerNamed && !opts.anonymous;
  if (phase !== "revealed") throw new VoteError("bad_state", "Lock voting and reveal the results first.");

  const bases = db
    .prepare(
      `SELECT i.id, i.column_id AS columnId, c.name AS column, (c.kind = 'normal') AS grouped, c.kind AS kind, c.position AS pos,
              i.code, i.audience, i.title, i.summary, i.restored_stars AS restoredStars, i.restored_voters AS restoredVoters
       FROM ideas i JOIN columns c ON c.id = i.column_id WHERE i.session_id = ?`,
    )
    .all(sid) as Base[];

  const votes = db
    .prepare(
      `SELECT v.token, v.idea_id AS ideaId, v.value, p.name FROM votes v
       JOIN participants p ON p.token = v.token JOIN ideas i ON i.id = v.idea_id AND i.session_id = p.session_id
       WHERE p.session_id = ?`,
    )
    .all(sid) as Vote[];

  // Rank polls: each person's ranks are tidied to 1, 2, 3 before counting, in case options were deleted after they voted.
  const slots = getLimits(db, sid).rankSlots;
  const position = new Map<string, Map<number, number>>(); // token -> idea -> place
  if (method === "rank") {
    const byToken = new Map<string, { ideaId: number; value: number }[]>();
    for (const v of votes) byToken.set(v.token, [...(byToken.get(v.token) ?? []), { ideaId: v.ideaId, value: v.value }]);
    for (const [token, rows] of byToken) position.set(token, compactRanks(rows));
  }
  const worth = (v: Vote) => {
    if (method === "rank") return Math.max(0, slots - (position.get(v.token)?.get(v.ideaId) ?? slots + 1) + 1);
    if (method === "dots") return 1;
    return v.value;
  };

  const scores = new Map<number, Score>(bases.map((b) => [b.id, { n: b.restoredStars, d: method === "score" ? 0 : 1, count: 0 }]));
  for (const v of votes) {
    const s = scores.get(v.ideaId)!;
    s.n += worth(v);
    s.count += 1;
    if (method === "score") s.d += 1;
  }

  /** Positive when y scores higher than x, so a sort with this puts the best first. */
  const byScore = (x: Score, y: Score) => {
    if (x.d === 0 || y.d === 0) return x.d === y.d ? 0 : x.d === 0 ? 1 : -1;
    return y.n * x.d - x.n * y.d;
  };
  const secondary = (s: Score) => (method === "score" ? s.count : 0);
  const compare = (a: Base, b: Base) => {
    const [x, y] = [scores.get(a.id)!, scores.get(b.id)!];
    return byScore(x, y) || secondary(y) - secondary(x) || Number(a.kind === "group") - Number(b.kind === "group") || a.pos - b.pos || a.id - b.id;
  };
  const sameScore = (a: Base, b: Base) => {
    const [x, y] = [scores.get(a.id)!, scores.get(b.id)!];
    return byScore(x, y) === 0 && secondary(x) === secondary(y);
  };

  const ordered = [...bases].sort(compare);

  // Names, with the value when it means something: "Ann: 4" (score, points) or "Ann: #2" (rank).
  const voters = new Map<number, string[]>();
  if (namedResults) {
    const label = (v: Vote) =>
      method === "dots" ? v.name : method === "rank" ? `${v.name}: #${position.get(v.token)?.get(v.ideaId)}` : `${v.name}: ${v.value}`;
    for (const v of [...votes].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
      voters.set(v.ideaId, [...(voters.get(v.ideaId) ?? []), label(v)]);
    }
    for (const b of bases) {
      if (!b.restoredVoters) continue;
      const merged = new Set([...(voters.get(b.id) ?? []), ...(JSON.parse(b.restoredVoters) as string[])]);
      voters.set(b.id, [...merged].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" })));
    }
  }

  let rank = 0;
  const rows: ResultRow[] = ordered.map((b, i) => {
    if (i === 0 || !sameScore(ordered[i - 1], b)) rank = i + 1;
    const tied = (i > 0 && sameScore(ordered[i - 1], b)) || (i < ordered.length - 1 && sameScore(b, ordered[i + 1]));
    const s = scores.get(b.id)!;
    const { restoredVoters: _v, restoredStars: _s, kind: _k, pos: _p, ...base } = b;
    const row: ResultRow = {
      ...base,
      grouped: !!b.grouped,
      stars: method === "score" ? (s.d ? round2(s.n / s.d) : 0) : s.n,
      ratings: s.count,
      rank,
      tied,
    };
    if (namedResults) row.voters = voters.get(b.id) ?? [];
    return row;
  });

  const one = (sql: string) => (db.prepare(sql).get(sid) as { n: number }).n;
  return {
    method,
    named: namedResults,
    restored: (db.prepare("SELECT value FROM settings WHERE session_id = ? AND key = 'restored'").get(sid) as { value: string } | undefined)?.value === "1",
    totals: {
      joined: one("SELECT COUNT(*) AS n FROM participants WHERE session_id = ?"),
      submitted: one("SELECT COUNT(*) AS n FROM participants WHERE session_id = ? AND submitted = 1"),
      voted: one("SELECT COUNT(DISTINCT v.token) AS n FROM votes v JOIN participants p ON p.token = v.token WHERE p.session_id = ?"),
      stars: method === "score" ? rows.reduce((sum, r) => sum + r.ratings, 0) : rows.reduce((sum, r) => sum + r.stars, 0),
    },
    rows,
  };
}

/** Spreadsheets run text that starts with = + - or @ as a formula; neutralise it, since titles come from participants. */
const cell = (value: string | number) => {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** What the score column is called, by method. */
const SCORE_LABEL: Record<Method, string> = { dots: "Votes", points: "Points", rank: "Borda points", score: "Average score" };

export function resultsToCsv(results: Results): string {
  const score = results.method === "score";
  const header = [
    "Rank", "Tied", "Code", "Option", "Group", "Tag", SCORE_LABEL[results.method], ...(score ? ["Ratings"] : []),
    ...(results.named ? ["Voted by"] : []),
  ];
  const lines = [header, ...results.rows.map((r) => [
    r.rank, r.tied ? "yes" : "", r.code, r.title, r.grouped ? r.column : "", r.audience, r.stars, ...(score ? [r.ratings] : []),
    ...(results.named ? [(r.voters ?? []).join("; ")] : []),
  ])];
  return "﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
}
