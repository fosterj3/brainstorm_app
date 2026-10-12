import { DEFAULT_IDEAS_PER_PERSON, DEFAULT_VOTES_PER_PERSON, type DB } from "./db";
import { VoteError } from "./errors";

/** setup: collecting ideas. voting: stars open. locked: stars closed. */
export type Phase = "setup" | "voting" | "locked";
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
  timer: Timer;
}

export type SettingKey =
  | "votes_per_person" | "ideas_open" | "ideas_per_person" | "named_results" | "auto_lock"
  | "phase" | "timer_duration_sec" | "timer_state" | "timer_ends_at" | "timer_remaining_ms";

export const MAX_TIMER_SEC = 4 * 60 * 60;
export const MIN_TIMER_SEC = 10;

export function setSetting(db: DB, key: SettingKey, value: string | number | boolean | null) {
  const v = value === null ? "" : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, v);
}

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string) => (raw.get(key) ? Number(raw.get(key)) : NaN);
  const posInt = (key: string, fallback: number) => (Number.isInteger(num(key)) && num(key) > 0 ? num(key) : fallback);

  const phase: Phase = raw.get("phase") === "voting" || raw.get("phase") === "locked" ? (raw.get("phase") as Phase) : "setup";
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
    timer,
  };
}

function writeTimer(db: DB, t: { state: TimerState; endsAt?: number | null; remainingMs?: number | null }) {
  setSetting(db, "timer_state", t.state);
  setSetting(db, "timer_ends_at", t.endsAt ?? null);
  setSetting(db, "timer_remaining_ms", t.remainingMs ?? null);
}

/**
 * Apply anything that has become true because time passed: a running timer that reached zero is marked
 * ended, and voting locks if the facilitator chose auto-lock. Returns true if something changed.
 */
export function reconcile(db: DB, now: number): boolean {
  return db.transaction(() => {
    const s = getSettings(db);
    if (s.timer.state !== "running" || s.timer.endsAt === null || now < s.timer.endsAt) return false;
    writeTimer(db, { state: "ended" });
    if (s.autoLock && s.phase === "voting") setSetting(db, "phase", "locked");
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

export type Action = "start" | "pause" | "resume" | "extend" | "lock" | "reopen";

/** Facilitator controls. Every transition is validated against the current phase and timer. */
export function applyAction(db: DB, action: Action, now: number, seconds?: number) {
  db.transaction(() => {
    reconcile(db, now);
    const s = getSettings(db);
    const { timer } = s;

    switch (action) {
      case "start": {
        need(s.phase === "setup", "Voting has already started.");
        setSetting(db, "phase", "voting");
        if (timer.durationSec) writeTimer(db, { state: "running", endsAt: now + timer.durationSec * 1000 });
        else writeTimer(db, { state: "stopped" });
        return;
      }
      case "pause": {
        need(s.phase === "voting" && timer.state === "running" && timer.endsAt !== null, "The timer is not running.");
        writeTimer(db, { state: "paused", remainingMs: Math.max(0, timer.endsAt! - now) });
        return;
      }
      case "resume": {
        need(s.phase === "voting" && timer.state === "paused" && timer.remainingMs !== null, "The timer is not paused.");
        writeTimer(db, { state: "running", endsAt: now + timer.remainingMs! });
        return;
      }
      case "extend": {
        const sec = checkSeconds(seconds);
        need(s.phase !== "setup", "Start voting first. Before that, change the timer in settings.");
        if (timer.state === "running") writeTimer(db, { state: "running", endsAt: timer.endsAt! + sec * 1000 });
        else if (timer.state === "paused") writeTimer(db, { state: "paused", remainingMs: timer.remainingMs! + sec * 1000 });
        else writeTimer(db, { state: "running", endsAt: now + sec * 1000 }); // ended, stopped, or reopening after a lock
        setSetting(db, "phase", "voting");
        return;
      }
      case "lock": {
        need(s.phase === "voting", "Voting is not open.");
        setSetting(db, "phase", "locked");
        writeTimer(db, { state: timer.state === "running" || timer.state === "paused" ? "stopped" : timer.state });
        return;
      }
      case "reopen": {
        need(s.phase === "locked", "Voting is not locked.");
        setSetting(db, "phase", "voting");
        writeTimer(db, { state: "stopped" });
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

export function updateSettings(db: DB, patch: SettingsPatch) {
  db.transaction(() => {
    const s = getSettings(db);
    if (patch.votesPerPerson !== undefined) {
      need(s.phase === "setup", "Votes per person can only change before voting starts.");
      setSetting(db, "votes_per_person", intIn(patch.votesPerPerson, 1, 20, "Votes per person"));
    }
    if (patch.timerSeconds !== undefined) {
      need(s.phase === "setup", "The timer length can only change before voting starts. Use extend once voting is open.");
      setSetting(db, "timer_duration_sec", patch.timerSeconds === null ? null : checkSeconds(patch.timerSeconds));
    }
    if (patch.ideasPerPerson !== undefined) setSetting(db, "ideas_per_person", intIn(patch.ideasPerPerson, 1, 20, "Ideas per person"));
    if (patch.ideasOpen !== undefined) setSetting(db, "ideas_open", patch.ideasOpen === true);
    if (patch.namedResults !== undefined) setSetting(db, "named_results", patch.namedResults === true);
    if (patch.autoLock !== undefined) setSetting(db, "auto_lock", patch.autoLock === true);
  })();
}
