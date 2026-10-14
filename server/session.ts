import { DEFAULT_IDEAS_PER_PERSON, DEFAULT_VOTES_PER_PERSON, type DB } from "./db";
import { VoteError } from "./errors";

/** setup: collecting ideas. voting: stars open. locked: stars closed. revealed: facilitator is showing results. */
export type Phase = "setup" | "voting" | "locked" | "revealed";
export type TimerState = "stopped" | "running" | "paused" | "ended";

export interface Timer {
  /** Length chosen by the facilitator; null means no timer. */
  durationSec: number | null;
  state: TimerState;
  /** Epoch ms the timer ends; only set while running. */
  endsAt: number | null;
  /** Time left; only set while paused. */
  remainingMs: number | null;
}

export interface Settings {
  votesPerPerson: number;
  /** Whether participants may suggest ideas (only possible during setup). */
  ideasOpen: boolean;
  /** Max ideas each participant may suggest. */
  ideasPerPerson: number;
  /** Named results (true) or anonymous results (false). Used when results are revealed. */
  namedResults: boolean;
  /** Lock voting automatically when the timer runs out. */
  autoLock: boolean;
  phase: Phase;
  locked: boolean;
  revealed: boolean;
  timer: Timer;
}

export type SettingKey =
  | "votes_per_person" | "ideas_open" | "ideas_per_person" | "named_results" | "auto_lock"
  | "restored" | "phase" | "timer_duration_sec" | "timer_state" | "timer_ends_at" | "timer_remaining_ms";

export const MAX_TIMER_SEC = 4 * 60 * 60;
export const MIN_TIMER_SEC = 10;

export function setSetting(db: DB, sid: string, key: SettingKey, value: string | number | boolean | null) {
  const v = value === null ? "" : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  db.prepare(
    "INSERT INTO settings (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value",
  ).run(sid, key, v);
}

export function getSettings(db: DB, sid: string): Settings {
  const rows = db.prepare("SELECT key, value FROM settings WHERE session_id = ?").all(sid) as { key: string; value: string }[];
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string) => (raw.get(key) ? Number(raw.get(key)) : NaN);
  const posInt = (key: string, fallback: number) => (Number.isInteger(num(key)) && num(key) > 0 ? num(key) : fallback);

  const phase: Phase = (["voting", "locked", "revealed"] as const).find((p) => p === raw.get("phase")) ?? "setup";
  const state = (["running", "paused", "ended"] as const).find((s) => s === raw.get("timer_state")) ?? "stopped";
  const timer: Timer = {
    durationSec: num("timer_duration_sec") > 0 ? num("timer_duration_sec") : null,
    state,
    endsAt: state === "running" ? num("timer_ends_at") : null,
    remainingMs: state === "paused" ? num("timer_remaining_ms") : null,
  };
  return {
    votesPerPerson: posInt("votes_per_person", DEFAULT_VOTES_PER_PERSON),
    ideasOpen: raw.get("ideas_open") !== "0",
    ideasPerPerson: posInt("ideas_per_person", DEFAULT_IDEAS_PER_PERSON),
    namedResults: raw.get("named_results") === "1",
    autoLock: raw.get("auto_lock") === "1",
    phase,
    locked: phase === "locked",
    revealed: phase === "revealed",
    timer,
  };
}

function writeTimer(db: DB, sid: string, t: { state: TimerState; endsAt?: number | null; remainingMs?: number | null }) {
  setSetting(db, sid, "timer_state", t.state);
  setSetting(db, sid, "timer_ends_at", t.endsAt ?? null);
  setSetting(db, sid, "timer_remaining_ms", t.remainingMs ?? null);
}

/**
 * Apply anything that has become true because time passed: a running timer that reached zero is marked
 * ended, and voting locks if the facilitator chose auto-lock. Returns true if something changed.
 */
export function reconcile(db: DB, sid: string, now: number): boolean {
  return db.transaction(() => {
    const s = getSettings(db, sid);
    if (s.timer.state !== "running" || s.timer.endsAt === null || now < s.timer.endsAt) return false;
    writeTimer(db, sid, { state: "ended" });
    if (s.autoLock && s.phase === "voting") setSetting(db, sid, "phase", "locked");
    return true;
  })();
}

const need = (cond: boolean, message: string) => {
  if (!cond) throw new VoteError("bad_state", message);
};

const checkSeconds = (seconds: unknown): number => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < MIN_TIMER_SEC || n > MAX_TIMER_SEC) {
    throw new VoteError("bad_input", `Choose a time between ${MIN_TIMER_SEC} seconds and ${MAX_TIMER_SEC / 3600} hours.`);
  }
  return Math.round(n);
};

export type Action = "start" | "pause" | "resume" | "extend" | "lock" | "reopen" | "reveal" | "hide";

/** Facilitator controls. Every transition is validated against the current phase and timer. */
export function applyAction(db: DB, sid: string, action: Action, now: number, seconds?: number) {
  db.transaction(() => {
    reconcile(db, sid, now);
    const s = getSettings(db, sid);
    const { timer } = s;

    switch (action) {
      case "start": {
        need(s.phase === "setup", "Voting has already started.");
        setSetting(db, sid, "phase", "voting");
        if (timer.durationSec) writeTimer(db, sid, { state: "running", endsAt: now + timer.durationSec * 1000 });
        else writeTimer(db, sid, { state: "stopped" });
        return;
      }
      case "pause": {
        need(s.phase === "voting" && timer.state === "running" && timer.endsAt !== null, "The timer is not running.");
        writeTimer(db, sid, { state: "paused", remainingMs: Math.max(0, timer.endsAt! - now) });
        return;
      }
      case "resume": {
        need(s.phase === "voting" && timer.state === "paused" && timer.remainingMs !== null, "The timer is not paused.");
        writeTimer(db, sid, { state: "running", endsAt: now + timer.remainingMs! });
        return;
      }
      case "extend": {
        const sec = checkSeconds(seconds);
        need(s.phase !== "setup", "Start voting first. Before that, change the timer in settings.");
        need(s.phase !== "revealed", "Hide the results before changing the time.");
        if (timer.state === "running") writeTimer(db, sid, { state: "running", endsAt: timer.endsAt! + sec * 1000 });
        else if (timer.state === "paused") writeTimer(db, sid, { state: "paused", remainingMs: timer.remainingMs! + sec * 1000 });
        else writeTimer(db, sid, { state: "running", endsAt: now + sec * 1000 }); // ended, stopped, or reopening after a lock
        setSetting(db, sid, "phase", "voting");
        return;
      }
      case "lock": {
        need(s.phase === "voting", "Voting is not open.");
        setSetting(db, sid, "phase", "locked");
        writeTimer(db, sid, { state: timer.state === "running" || timer.state === "paused" ? "stopped" : timer.state });
        return;
      }
      case "reopen": {
        need(s.phase === "locked", "Voting is not locked.");
        setSetting(db, sid, "phase", "voting");
        writeTimer(db, sid, { state: "stopped" });
        return;
      }
      case "reveal": {
        need(s.phase === "locked", "Lock voting before revealing the results.");
        setSetting(db, sid, "phase", "revealed");
        return;
      }
      case "hide": {
        need(s.phase === "revealed", "The results are not showing.");
        setSetting(db, sid, "phase", "locked");
        return;
      }
    }
  })();
}

export interface SettingsPatch {
  votesPerPerson?: number;
  ideasPerPerson?: number;
  ideasOpen?: boolean;
  namedResults?: boolean;
  autoLock?: boolean;
  /** Seconds, or null for no timer. Only while setting up. */
  timerSeconds?: number | null;
}

const intIn = (v: unknown, min: number, max: number, label: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new VoteError("bad_input", `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

export function updateSettings(db: DB, sid: string, patch: SettingsPatch) {
  db.transaction(() => {
    const s = getSettings(db, sid);
    if (patch.votesPerPerson !== undefined) {
      need(s.phase === "setup", "Votes per person can only change before voting starts.");
      setSetting(db, sid, "votes_per_person", intIn(patch.votesPerPerson, 1, 20, "Votes per person"));
    }
    if (patch.timerSeconds !== undefined) {
      need(s.phase === "setup", "The timer length can only change before voting starts. Use extend once voting is open.");
      setSetting(db, sid, "timer_duration_sec", patch.timerSeconds === null ? null : checkSeconds(patch.timerSeconds));
    }
    if (patch.namedResults !== undefined) need(s.phase !== "revealed", "Hide the results before changing who they show.");
    if (patch.ideasPerPerson !== undefined) setSetting(db, sid, "ideas_per_person", intIn(patch.ideasPerPerson, 1, 20, "Ideas per person"));
    if (patch.ideasOpen !== undefined) setSetting(db, sid, "ideas_open", patch.ideasOpen === true);
    if (patch.namedResults !== undefined) setSetting(db, sid, "named_results", patch.namedResults === true);
    if (patch.autoLock !== undefined) setSetting(db, sid, "auto_lock", patch.autoLock === true);
  })();
}
