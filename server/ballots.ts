import type { DB } from "./db";
import { VoteError } from "./errors";
import type { Method } from "./session";

/**
 * Voting methods other than dots work on a whole ballot: a map from option id to a value. The value is a rank,
 * a 1 to 5 score, or a number of points, depending on the poll's method. These rules are enforced on the server.
 */
export const SCORE_MAX = 5;
export const POINTS_TOTAL = 100;
/** With this many options or fewer, people rank all of them. With more, they rank their top few. */
export const RANK_ALL_MAX = 10;
export const RANK_TOP = 5;

export interface Limits {
  /** How many options each person ranks (all of them, or the top few in a long list). */
  rankSlots: number;
  scoreMax: number;
  pointsTotal: number;
}

export function getLimits(db: DB, sid: string): Limits {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE session_id = ?").get(sid) as { n: number };
  return { rankSlots: n <= RANK_ALL_MAX ? n : RANK_TOP, scoreMax: SCORE_MAX, pointsTotal: POINTS_TOTAL };
}

export interface BallotRow {
  ideaId: number;
  value: number;
}

/** One person's ballot for one poll, in a stable order (by value, then option). */
export function ballotRows(db: DB, sid: string, token: string): BallotRow[] {
  return db
    .prepare(
      `SELECT v.idea_id AS ideaId, v.value FROM votes v JOIN ideas i ON i.id = v.idea_id
       WHERE v.token = ? AND i.session_id = ? ORDER BY v.value, v.idea_id`,
    )
    .all(token, sid) as BallotRow[];
}

const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/**
 * Check a ballot for the poll's method and return it as clean rows. Throws bad_input with a plain message.
 * Points of zero mean "none", so they are dropped.
 */
export function validateBallot(method: Method, values: unknown, limits: Limits): BallotRow[] {
  if (method === "dots") throw new VoteError("bad_state", "This poll uses dot voting, so people vote one option at a time.");
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new VoteError("bad_input", "That ballot was not valid.");
  const rows: BallotRow[] = [];
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const ideaId = Number(key);
    if (!Number.isInteger(ideaId) || ideaId <= 0 || !whole(value)) throw new VoteError("bad_input", "That ballot was not valid.");
    rows.push({ ideaId, value: value as number });
  }

  if (method === "rank") {
    if (rows.length > limits.rankSlots) throw new VoteError("cap_reached", `You can rank at most ${limits.rankSlots} options.`);
    const ranks = rows.map((r) => r.value).sort((a, b) => a - b);
    if (!ranks.every((r, i) => r === i + 1)) throw new VoteError("bad_input", "Each option needs its own place in your ranking, starting at 1.");
    return rows;
  }
  if (method === "score") {
    if (rows.some((r) => r.value < 1 || r.value > limits.scoreMax)) throw new VoteError("bad_input", `Scores go from 1 to ${limits.scoreMax}.`);
    return rows;
  }
  // points
  if (rows.some((r) => r.value < 0)) throw new VoteError("bad_input", "Points cannot be negative.");
  const kept = rows.filter((r) => r.value > 0);
  const total = kept.reduce((s, r) => s + r.value, 0);
  if (total > limits.pointsTotal) throw new VoteError("cap_reached", `You can give out at most ${limits.pointsTotal} points. You have used ${total}.`);
  return kept;
}

/** Whether a ballot is finished enough to submit. */
export function isComplete(method: Method, rows: BallotRow[], limits: Limits): boolean {
  switch (method) {
    case "dots":
    case "score":
      return rows.length > 0;
    case "rank":
      return limits.rankSlots > 0 && rows.length >= limits.rankSlots;
    case "points":
      return rows.reduce((s, r) => s + r.value, 0) === limits.pointsTotal;
  }
}

/** The message shown when someone tries to submit an unfinished ballot. */
export function incompleteMessage(method: Method, limits: Limits): string {
  switch (method) {
    case "dots": return "Vote for at least one option before submitting.";
    case "score": return "Rate at least one option before submitting.";
    case "rank": return limits.rankSlots === 1 ? "Rank your option before submitting." : `Rank ${limits.rankSlots} options before submitting.`;
    case "points": return `Use all ${limits.pointsTotal} points before submitting.`;
  }
}

/** Order a person's rank rows 1, 2, 3 with no gaps (options may have been deleted since they voted). */
export function compactRanks(rows: BallotRow[]): Map<number, number> {
  const sorted = [...rows].sort((a, b) => a.value - b.value || a.ideaId - b.ideaId);
  return new Map(sorted.map((r, i) => [r.ideaId, i + 1]));
}
