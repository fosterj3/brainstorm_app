import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "./db";
import { newBoard } from "./testutil";
import { applyAction, getSettings, reconcile, updateSettings } from "./session";
import { VoteError, join, setVote } from "./votes";

let db: DB;
let sid: string;
const T0 = 1_000_000;

beforeEach(() => {
  ({ db, sid } = newBoard(2));
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

describe("starting with and without a timer", () => {
  it("starts with no timer when none was chosen", () => {
    applyAction(db, sid, "start", T0);
    const s = getSettings(db, sid);
    expect(s.phase).toBe("voting");
    expect(s.timer.state).toBe("stopped");
    expect(s.timer.durationSec).toBeNull();
  });
  it("starts the countdown from the chosen length", () => {
    updateSettings(db, sid, { timerSeconds: 300 });
    applyAction(db, sid, "start", T0);
    const { timer } = getSettings(db, sid);
    expect(timer.state).toBe("running");
    expect(timer.endsAt).toBe(T0 + 300_000);
  });
  it("can clear the timer again before starting", () => {
    updateSettings(db, sid, { timerSeconds: 300 });
    updateSettings(db, sid, { timerSeconds: null });
    expect(getSettings(db, sid).timer.durationSec).toBeNull();
  });
  it("rejects silly timer lengths", () => {
    expect(code(() => updateSettings(db, sid, { timerSeconds: 2 }))).toBe("bad_input");
    expect(code(() => updateSettings(db, sid, { timerSeconds: 99 * 3600 }))).toBe("bad_input");
  });
  it("cannot start twice", () => {
    applyAction(db, sid, "start", T0);
    expect(code(() => applyAction(db, sid, "start", T0))).toBe("bad_state");
  });
});

describe("pause, resume and extend", () => {
  beforeEach(() => {
    updateSettings(db, sid, { timerSeconds: 300 });
    applyAction(db, sid, "start", T0);
  });

  it("pauses with the time left and resumes from it", () => {
    applyAction(db, sid, "pause", T0 + 100_000);
    expect(getSettings(db, sid).timer).toMatchObject({ state: "paused", remainingMs: 200_000 });
    applyAction(db, sid, "resume", T0 + 500_000);
    expect(getSettings(db, sid).timer).toMatchObject({ state: "running", endsAt: T0 + 700_000 });
  });
  it("extends a running timer", () => {
    applyAction(db, sid, "extend", T0 + 10_000, 60);
    expect(getSettings(db, sid).timer.endsAt).toBe(T0 + 360_000);
  });
  it("extends a paused timer without starting it", () => {
    applyAction(db, sid, "pause", T0 + 100_000);
    applyAction(db, sid, "extend", T0 + 100_000, 60);
    expect(getSettings(db, sid).timer).toMatchObject({ state: "paused", remainingMs: 260_000 });
  });
  it("only pauses a running timer", () => {
    applyAction(db, sid, "pause", T0);
    expect(code(() => applyAction(db, sid, "pause", T0))).toBe("bad_state");
  });
  it("extends only with a sensible number of seconds", () => {
    expect(code(() => applyAction(db, sid, "extend", T0, 0))).toBe("bad_input");
  });
});

describe("running out of time", () => {
  it("marks the timer ended but leaves voting open when auto-lock is off", () => {
    updateSettings(db, sid, { timerSeconds: 60 });
    applyAction(db, sid, "start", T0);
    expect(reconcile(db, sid, T0 + 59_000)).toBe(false);
    expect(reconcile(db, sid, T0 + 60_000)).toBe(true);
    const s = getSettings(db, sid);
    expect(s.timer.state).toBe("ended");
    expect(s.phase).toBe("voting");
  });
  it("locks voting at zero when auto-lock is on", () => {
    updateSettings(db, sid, { timerSeconds: 60, autoLock: true });
    applyAction(db, sid, "start", T0);
    const alex = join(db, sid, "Alex").token;
    expect(() => setVote(db, sid, alex, 1, true, T0 + 30_000)).not.toThrow();
    expect(code(() => setVote(db, sid, alex, 2, true, T0 + 61_000))).toBe("locked");
    expect(getSettings(db, sid).phase).toBe("locked");
  });
  it("extending after time is up restarts the clock", () => {
    updateSettings(db, sid, { timerSeconds: 60 });
    applyAction(db, sid, "start", T0);
    applyAction(db, sid, "extend", T0 + 90_000, 120);
    expect(getSettings(db, sid).timer).toMatchObject({ state: "running", endsAt: T0 + 210_000 });
  });
  it("extending after an auto-lock reopens voting", () => {
    updateSettings(db, sid, { timerSeconds: 60, autoLock: true });
    applyAction(db, sid, "start", T0);
    applyAction(db, sid, "extend", T0 + 90_000, 120);
    const s = getSettings(db, sid);
    expect(s.phase).toBe("voting");
    expect(s.timer.state).toBe("running");
  });
});

describe("lock and reopen", () => {
  it("locks and reopens voting, with no timer", () => {
    applyAction(db, sid, "start", T0);
    applyAction(db, sid, "lock", T0);
    expect(getSettings(db, sid).locked).toBe(true);
    applyAction(db, sid, "reopen", T0);
    expect(getSettings(db, sid).phase).toBe("voting");
  });
  it("stops the timer when locked manually", () => {
    updateSettings(db, sid, { timerSeconds: 300 });
    applyAction(db, sid, "start", T0);
    applyAction(db, sid, "lock", T0 + 10_000);
    expect(getSettings(db, sid).timer.state).toBe("stopped");
  });
  it("cannot lock before starting or reopen when not locked", () => {
    expect(code(() => applyAction(db, sid, "lock", T0))).toBe("bad_state");
    applyAction(db, sid, "start", T0);
    expect(code(() => applyAction(db, sid, "reopen", T0))).toBe("bad_state");
  });
});

describe("settings", () => {
  it("changes votes per person only before voting starts", () => {
    updateSettings(db, sid, { votesPerPerson: 5 });
    expect(getSettings(db, sid).votesPerPerson).toBe(5);
    applyAction(db, sid, "start", T0);
    expect(code(() => updateSettings(db, sid, { votesPerPerson: 2 }))).toBe("bad_state");
  });
  it("validates ranges", () => {
    expect(code(() => updateSettings(db, sid, { votesPerPerson: 0 }))).toBe("bad_input");
    expect(code(() => updateSettings(db, sid, { votesPerPerson: 2.5 }))).toBe("bad_input");
  });
  it("stores anonymity and auto-lock as settings", () => {
    updateSettings(db, sid, { namedResults: true, autoLock: true });
    expect(getSettings(db, sid)).toMatchObject({ namedResults: true, autoLock: true });
  });
});
