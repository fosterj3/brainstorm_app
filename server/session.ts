import { DEFAULT_IDEAS_PER_PERSON, DEFAULT_VOTES_PER_PERSON, type DB } from "./db";
import { VoteError } from "./errors";

/** setup: collecting options. voting: votes open. locked: votes closed. revealed: the organizer is showing results. */
export type Phase = "setup" | "voting" | "locked" | "revealed";
/** How people vote: dots (spend a fixed number of votes), rank order, a score from 1 to 5, or a split of 100 points. */
export type Method = "dots" | "rank" | "score" | "points";
export const METHODS: readonly Method[] = ["dots", "rank", "score", "points"];
/** live: the organizer runs a timed session. poll: people vote any time before a stored deadline. */
export type Mode = "live" | "poll";
export const MODES: readonly Mode[] = ["live", "poll"];

export type TimerState = "stopped" | "running" | "paused" | "ended";

export interface Timer {
  /** Length chosen by the organizer; null means no timer. */
  durationSec: number | null;
  state: TimerState;
  /** Epoch ms the timer ends; only set while running. */
  endsAt: number | null;
  /** Time left; only set while paused. */
  remainingMs: number | null;
}

export interface Settings {
  method: Method;
  mode: Mode;
  /** Epoch ms when an open poll closes by itself, or null for no deadline. Stored, so it survives restarts. */
  deadline: number | null;
  /** Open polls: participants may see the anonymous results after the poll closes. Off by default. */
  shareResults: boolean;
  votesPerPerson: number;
  /** Whether participants may suggest options (only possible during setup). */
  ideasOpen: boolean;
  /** Max options each participant may suggest. */
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
  | "method" | "mode" | "deadline" | "share_results" | "votes_per_person" | "ideas_open" | "ideas_per_person" | "named_results" | "auto_lock"
  | "restored" | "results_seen" | "net_salt" | "phase" | "timer_duration_sec" | "timer_state" | "timer_ends_at" | "timer_remaining_ms";

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
    method: METHODS.find((m) => m === raw.get("method")) ?? "dots",
    mode: MODES.find((m) => m === raw.get("mode")) ?? "live",
    deadline: num("deadline") > 0 ? num("deadline") : null,
    shareResults: raw.get("share_results") === "1",
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
 * ended, and voting locks if the organizer chose auto-lock. Returns true if something changed.
 */
export function reconcile(db: DB, sid: string, now: number): boolean {
  return db.transaction(() => {
    const s = getSettings(db, sid);
    let changed = false;
    if (s.timer.state === "running" && s.timer.endsAt !== null && now >= s.timer.endsAt) {
      writeTimer(db, sid, { state: "ended" });
      if (s.autoLock && s.phase === "voting") setSetting(db, sid, "phase", "locked");
      changed = true;
    }
    // An open poll closes itself at its stored deadline and shows its results to the organizer. This reads the stored
    // time on every request, never an in-memory timer, so it holds across restarts and sleeping servers.
    if (s.mode === "poll" && s.phase === "voting" && s.deadline !== null && now >= s.deadline) {
      setSetting(db, sid, "phase", "revealed");
      setSetting(db, sid, "results_seen", true);
      changed = true;
    }
    return changed;
  })();
}

/** True once the organizer has ever been shown this poll's results (and they have not been cleared since). */
export const resultsSeen = (db: DB, sid: string): boolean =>
  (db.prepare("SELECT value FROM settings WHERE session_id = ? AND key = 'results_seen'").get(sid) as { value: string } | undefined)?.value === "1";

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

export type Action = "start" | "pause" | "resume" | "extend" | "lock" | "reopen" | "reveal" | "hide" | "close";

/** Organizer controls. Every transition is validated against the current phase and timer. */
/** The longest an open poll can stay open, so a forgotten poll cannot sit open for years. */
export const MAX_DEADLINE_MS = 365 * 24 * 60 * 60 * 1000;

/** A deadline must be a real time in the future and not absurdly far away. */
export function checkDeadline(value: unknown, now: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= now) throw new VoteError("bad_input", "Choose a closing time in the future.");
  if (n > now + MAX_DEADLINE_MS) throw new VoteError("bad_input", "A poll can stay open for at most a year.");
  return n;
}

export function applyAction(db: DB, sid: string, action: Action, now: number, seconds?: number, extra: { deadline?: number | null } = {}) {
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
      case "close": {
        // Open polls: end voting now and show the results to the organizer.
        need(s.mode === "poll", "Only open polls can be closed this way. Use lock and reveal in a live session.");
        need(s.phase === "voting", "This poll is not open.");
        setSetting(db, sid, "phase", "revealed");
        setSetting(db, sid, "results_seen", true);
        return;
      }
      case "reopen": {
        if (s.mode === "poll") {
          need(s.phase === "revealed" || s.phase === "locked", "This poll is still open.");
          // A reopened poll needs a closing time in the future, or none. An old deadline would close it again at once.
          if (extra.deadline !== undefined) setSetting(db, sid, "deadline", extra.deadline === null ? null : checkDeadline(extra.deadline, now));
          else setSetting(db, sid, "deadline", null);
          setSetting(db, sid, "phase", "voting");
          return;
        }
        need(s.phase === "locked", "Voting is not locked.");
        setSetting(db, sid, "phase", "voting");
        writeTimer(db, sid, { state: "stopped" });
        return;
      }
      case "reveal": {
        need(s.phase === "locked", "Lock voting before revealing the results.");
        setSetting(db, sid, "phase", "revealed");
        setSetting(db, sid, "results_seen", true);
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
  /** How people vote. Only while setting up. */
  method?: Method;
  votesPerPerson?: number;
  ideasPerPerson?: number;
  ideasOpen?: boolean;
  namedResults?: boolean;
  autoLock?: boolean;
  /** Seconds, or null for no timer. Only while setting up. */
  timerSeconds?: number | null;
  /** Open polls: when the poll closes by itself (epoch ms), or null for no deadline. */
  deadline?: number | null;
  /** Open polls: let participants see the (anonymous) results once the poll has closed. */
  shareResults?: boolean;
}

const intIn = (v: unknown, min: number, max: number, label: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new VoteError("bad_input", `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

export function updateSettings(db: DB, sid: string, patch: SettingsPatch, now = Date.now()) {
  db.transaction(() => {
    const s = getSettings(db, sid);
    if (patch.deadline !== undefined) {
      need(s.mode === "poll", "Only open polls have a closing time.");
      need(s.phase === "voting", "Reopen the poll before changing its closing time.");
      setSetting(db, sid, "deadline", patch.deadline === null ? null : checkDeadline(patch.deadline, now));
    }
    if (patch.shareResults !== undefined) {
      need(s.mode === "poll", "Sharing results with participants is only for open polls.");
      setSetting(db, sid, "share_results", patch.shareResults === true);
    }
    if (patch.method !== undefined) {
      need(s.phase === "setup", "The voting method can only change before voting starts.");
      const method = METHODS.find((m) => m === patch.method);
      if (!method) throw new VoteError("bad_input", "Choose a voting method from the list.");
      setSetting(db, sid, "method", method);
    }
    if (patch.votesPerPerson !== undefined) {
      need(s.phase === "setup", "Votes per person can only change before voting starts.");
      setSetting(db, sid, "votes_per_person", intIn(patch.votesPerPerson, 1, 20, "Votes per person"));
    }
    if (patch.timerSeconds !== undefined) {
      need(s.phase === "setup", "The timer length can only change before voting starts. Use extend once voting is open.");
      setSetting(db, sid, "timer_duration_sec", patch.timerSeconds === null ? null : checkSeconds(patch.timerSeconds));
    }
    if (patch.namedResults !== undefined) need(s.phase !== "revealed", "Hide the results before changing who they show.");
    if (patch.ideasPerPerson !== undefined) setSetting(db, sid, "ideas_per_person", intIn(patch.ideasPerPerson, 1, 20, "Options per person"));
    if (patch.ideasOpen !== undefined) setSetting(db, sid, "ideas_open", patch.ideasOpen === true);
    if (patch.namedResults !== undefined) setSetting(db, sid, "named_results", patch.namedResults === true);
    if (patch.autoLock !== undefined) setSetting(db, sid, "auto_lock", patch.autoLock === true);
  })();
}
