import { describe, expect, it } from "vitest";
import { format, remainingMs } from "./Countdown";
import type { Timer } from "./api";

const t = (p: Partial<Timer>): Timer => ({ durationSec: 300, state: "running", endsAt: null, remainingMs: null, ...p });

describe("countdown maths", () => {
  it("uses the server clock offset, not the device clock", () => {
    // Device clock is 5s behind the server: serverNow = local + 5000.
    const timer = t({ endsAt: 100_000 });
    expect(remainingMs(timer, 5_000, 90_000)).toBe(5_000); // server time 95s, 5s left
  });
  it("never goes below zero", () => {
    expect(remainingMs(t({ endsAt: 1_000 }), 0, 5_000)).toBe(0);
  });
  it("shows the frozen time while paused and zero once ended", () => {
    expect(remainingMs(t({ state: "paused", remainingMs: 42_000 }), 0, 0)).toBe(42_000);
    expect(remainingMs(t({ state: "ended" }), 0, 0)).toBe(0);
  });
  it("shows nothing when there is no timer running", () => {
    expect(remainingMs(t({ state: "stopped", durationSec: null }), 0, 0)).toBeNull();
  });
  it("formats m:ss, rounding up so zero only shows at zero", () => {
    expect(format(65_000)).toBe("1:05");
    expect(format(59_100)).toBe("1:00");
    expect(format(0)).toBe("0:00");
  });
});
