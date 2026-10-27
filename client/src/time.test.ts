import { describe, expect, it } from "vitest";
import { fromLocalInput, onlyNew, parseList, stripBullet, toLocalInput, tookText, untilText } from "./time";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("tookText", () => {
  it("speaks in seconds, minutes or hours", () => {
    expect(tookText(0)).toBe("0 sec");
    expect(tookText(42_000)).toBe("42 sec");
    expect(tookText(59_400)).toBe("59 sec");
    expect(tookText(MIN)).toBe("1 min");
    expect(tookText(3 * MIN + 20_000)).toBe("3 min 20 sec");
    expect(tookText(12 * MIN + 20_000)).toBe("12 min");
    expect(tookText(HOUR)).toBe("1 h");
    expect(tookText(2 * HOUR + 5 * MIN)).toBe("2 h 5 min");
  });
  it("never goes negative", () => expect(tookText(-5000)).toBe("0 sec"));
});

describe("untilText", () => {
  it("speaks in the largest sensible unit", () => {
    expect(untilText(1000 + 30_000, 1000)).toBe("in less than a minute");
    expect(untilText(1000 + MIN, 1000)).toBe("in 1 minute");
    expect(untilText(1000 + 45 * MIN, 1000)).toBe("in 45 minutes");
    expect(untilText(1000 + HOUR, 1000)).toBe("in 1 hour");
    expect(untilText(1000 + 5 * HOUR + 30 * MIN, 1000)).toBe("in 5 hours");
    expect(untilText(1000 + DAY, 1000)).toBe("in 1 day");
    expect(untilText(1000 + 6 * DAY + 20 * HOUR, 1000)).toBe("in 6 days");
  });
  it("says now once the time has come", () => {
    expect(untilText(1000, 1000)).toBe("now");
    expect(untilText(500, 1000)).toBe("now");
  });
});

describe("datetime-local text", () => {
  it("round-trips local time to the minute", () => {
    const ms = new Date(2026, 9, 30, 17, 5).getTime();
    expect(toLocalInput(ms)).toBe("2026-10-30T17:05");
    expect(fromLocalInput("2026-10-30T17:05")).toBe(ms);
  });
  it("gives null for nothing or nonsense", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("not a date")).toBeNull();
  });
});

describe("pasting a list of options", () => {
  it("strips bullets and numbers, blanks and repeats", () => {
    expect(stripBullet("1. Pizza")).toBe("Pizza");
    expect(stripBullet("2) Sushi")).toBe("Sushi");
    expect(stripBullet("- Tacos")).toBe("Tacos");
    expect(stripBullet("• Salad")).toBe("Salad");
    expect(stripBullet("3D printing")).toBe("3D printing"); // a title that merely starts with a digit stays whole
    expect(parseList("Pizza\r\n\r\n- Sushi\n1. Tacos\npizza\n   \n")).toEqual(["Pizza", "Sushi", "Tacos"]);
  });
  it("trims spaces inside and caps the title length", () => {
    expect(parseList("  Too    many   spaces ")).toEqual(["Too many spaces"]);
    expect(parseList("x".repeat(300))[0].length).toBe(120);
  });
  it("gives an empty list for empty text", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList("\n \n")).toEqual([]);
  });
});

describe("onlyNew", () => {
  it("leaves out titles that are already in the list, whatever their capitals", () => {
    expect(onlyNew(["Pizza", "Sushi"], ["pizza", "Tacos", " SUSHI ", "Salad"])).toEqual(["Tacos", "Salad"]);
    expect(onlyNew([], ["A", "B"])).toEqual(["A", "B"]);
    expect(onlyNew(["A"], [])).toEqual([]);
  });
});
