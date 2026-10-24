import { describe, expect, it } from "vitest";
import type { Limits } from "./api";
import { counterText, instruction, isReady, METHODS, moveItem, orderFromBallot, pointsUsed, rankValues, submitHint } from "./methods";

const limits = (rankSlots: number): Limits => ({ rankSlots, scoreMax: 5, pointsTotal: 100 });

describe("moveItem", () => {
  it("moves an item up, down and to the ends without changing the original", () => {
    const list = [1, 2, 3, 4];
    expect(moveItem(list, 2, 0)).toEqual([3, 1, 2, 4]);
    expect(moveItem(list, 0, 3)).toEqual([2, 3, 4, 1]);
    expect(moveItem(list, 1, 2)).toEqual([1, 3, 2, 4]);
    expect(list).toEqual([1, 2, 3, 4]);
  });
  it("ignores moves that go nowhere or off the list", () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 2, 3)).toBe(list);
  });
});

describe("rank helpers", () => {
  it("turns an order into places starting at 1", () => {
    expect(rankValues([7, 3, 9])).toEqual({ 7: 1, 3: 2, 9: 3 });
    expect(rankValues([])).toEqual({});
  });
  it("shows the saved ranking in place order, skipping options that no longer exist", () => {
    expect(orderFromBallot({ 5: 2, 3: 1, 8: 3 }, [3, 5], 3)).toEqual([3, 5]);
  });
  it("starts with every option in listed order when they all fit, or empty when the person must choose", () => {
    expect(orderFromBallot({}, [4, 5, 6], 3)).toEqual([4, 5, 6]);
    expect(orderFromBallot({}, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5)).toEqual([]);
  });
  it("never shows more than the allowed number of places", () => {
    expect(orderFromBallot({ 1: 1, 2: 2, 3: 3, 4: 4 }, [1, 2, 3, 4], 2)).toEqual([1, 2]);
  });
});

describe("ballot readiness mirrors the server's rules", () => {
  it("dots and score need at least one answer", () => {
    expect(isReady("dots", {}, limits(3), 0, 0)).toBe(false);
    expect(isReady("dots", {}, limits(3), 1, 0)).toBe(true);
    expect(isReady("score", {}, limits(3), 0, 0)).toBe(false);
    expect(isReady("score", { 1: 4 }, limits(3), 0, 0)).toBe(true);
  });
  it("rank needs every place filled", () => {
    expect(isReady("rank", {}, limits(4), 0, 3)).toBe(false);
    expect(isReady("rank", {}, limits(4), 0, 4)).toBe(true);
    expect(isReady("rank", {}, limits(0), 0, 0)).toBe(false);
  });
  it("points need exactly 100", () => {
    expect(pointsUsed({ 1: 60, 2: 40 })).toBe(100);
    expect(isReady("points", { 1: 60, 2: 39 }, limits(2), 0, 0)).toBe(false);
    expect(isReady("points", { 1: 60, 2: 41 }, limits(2), 0, 0)).toBe(false);
    expect(isReady("points", { 1: 60, 2: 40 }, limits(2), 0, 0)).toBe(true);
  });
});

describe("wording", () => {
  it("has a one-sentence explanation for every method", () => {
    expect(METHODS.map((m) => m.id)).toEqual(["dots", "rank", "score", "points"]);
    for (const m of METHODS) expect(m.blurb.split(". ").length).toBe(1);
  });
  it("describes progress for each method", () => {
    const base = { ballot: { 1: 60 }, limits: limits(3), votesPerPerson: 3, dotsUsed: 2, rankLength: 1, optionCount: 5 };
    expect(counterText("dots", base)).toBe("2 of 3 votes used");
    expect(counterText("rank", base)).toBe("1 of 3 ranked");
    expect(counterText("score", base)).toBe("1 of 5 rated");
    expect(counterText("points", base)).toBe("60 of 100 points used");
    expect(submitHint("points", { ...base, ready: false })).toBe("40 points left to give out.");
    expect(submitHint("points", { ...base, ballot: { 1: 120 }, ready: false })).toBe("You are 20 points over.");
  });
  it("tells people to choose a top few when the list is long", () => {
    expect(instruction("rank", { votesPerPerson: 3, limits: limits(5), optionCount: 12 })).toContain("top 5");
    expect(instruction("rank", { votesPerPerson: 3, limits: limits(4), optionCount: 4 })).toContain("in order");
  });
  it("uses no em dashes", () => {
    for (const m of METHODS) expect(m.blurb).not.toContain("—");
  });
});
