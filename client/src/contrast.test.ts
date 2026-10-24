import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG AA contrast for the Ority design tokens. The pairs below are the ones the stylesheet actually uses,
 * so a token change that breaks readability fails here. Text needs 4.5:1, large text and UI parts need 3:1.
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "styles.css"), "utf8");
const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
const token = (name: string): string => {
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6}|var\\(--([a-z0-9-]+)\\))`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[2] ? token(m[2]) : m[1];
};
const WHITE = "#ffffff";
const color = (v: string) => (v === "white" ? WHITE : token(v));

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum ratio, where it is used]
const PAIRS: [string, string, number, string][] = [
  ["text", "bg", 4.5, "body text on the page"],
  ["text", "surface", 4.5, "body text on panels and cards"],
  ["muted", "bg", 4.5, "hints on the page"],
  ["muted", "surface", 4.5, "hints on panels"],
  ["muted", "tint-1", 4.5, "hints on tinted areas"],
  ["brand", "surface", 4.5, "headings, links, tab labels"],
  ["brand", "bg", 4.5, "headings on the page"],
  ["white", "brand", 4.5, "primary buttons, header, footer, rank badges"],
  ["white", "brand-hover", 4.5, "primary button hover"],
  ["brand", "tint-1", 4.5, "counters, countdown, notices"],
  ["tint-3", "brand", 4.5, "footer tagline"],
  ["line", "surface", 3, "input and button borders"],
  ["line", "bg", 3, "input borders on the page"],
  ["tint-4", "surface", 3, "decorative UI lines"],
  ["amber", "surface", 4.5, "starred icon, top rank badge background (white text)"],
  ["white", "amber", 4.5, "rank 1 badge"],
  ["amber-text", "amber-bg", 4.5, "star totals, add-idea tile"],
  ["amber-text", "surface", 4.5, "star totals on white"],
  ["warn", "amber-bg", 4.5, "paused countdown, warnings"],
  ["ok", "ok-bg", 4.5, "submitted state, voting phase"],
  ["ok", "surface", 4.5, "success text"],
  ["danger", "surface", 4.5, "error text"],
  ["danger", "danger-bg", 4.5, "low-time countdown, urgent notices"],
  ["amber-glow", "brand", 3, "logo dot on dark surfaces"],
  ["brand", "surface", 3, "keyboard focus ring on light pages"],
  ["white", "brand", 3, "keyboard focus ring on the header and footer"],
];

describe("design token contrast (WCAG AA)", () => {
  for (const [fg, bg, min, where] of PAIRS) {
    it(`${fg} on ${bg} is at least ${min}:1 (${where})`, () => {
      expect(ratio(color(fg), color(bg))).toBeGreaterThanOrEqual(min);
    });
  }
});
