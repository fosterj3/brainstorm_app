import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../server/db";
import { listColumns, listIdeas } from "../server/ideas";
import { createSession } from "../server/sessions";
import { getSettings } from "../server/session";
import { METHODS } from "../server/session";
import { TEMPLATES, templateById } from "./templates";

const T0 = 1_000_000;

describe("templates", () => {
  it("has the six templates, in order", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      "Team priorities",
      "Feature or roadmap voting",
      "Post-survey action planning",
      "Offsite or event ideas",
      "Proposal or candidate ranking",
      "Quick group decision",
    ]);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(6);
    expect(templateById("quick-decision")?.name).toBe("Quick group decision");
    expect(templateById("nope")).toBeUndefined();
  });

  it("keeps the post-survey template equivalent to the original example poll", () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../ideas.example.json"), "utf8")) as {
      columns: { name: string; description: string; color: string }[];
      ideas: { column: string; code: string; audience: string; title: string; summary: string; details: string }[];
    };
    const t = templateById("survey-actions")!;
    expect(t.groups).toEqual(example.columns);
    expect(t.options).toEqual(example.ideas.map((i) => ({ group: i.column, code: i.code, tag: i.audience, title: i.title, summary: i.summary, details: i.details })));
  });

  for (const t of TEMPLATES) {
    describe(t.name, () => {
      it("fits the limits and the tone rules", () => {
        expect(t.title.length).toBeLessThanOrEqual(100);
        expect(t.prompt.length).toBeLessThanOrEqual(200);
        expect(t.options.length).toBeGreaterThanOrEqual(2);
        expect(METHODS).toContain(t.method);
        expect(t.closesInDays).toBeGreaterThan(0);
        for (const o of t.options) {
          expect(o.title.length).toBeLessThanOrEqual(120);
          expect((o.summary ?? "").length).toBeLessThanOrEqual(400);
        }
        const text = JSON.stringify(t);
        expect(text).not.toContain("—"); // no em dashes
        const groupNames = new Set((t.groups ?? []).map((g) => g.name));
        for (const o of t.options) if (o.group) expect(groupNames.has(o.group)).toBe(true);
      });

      it("creates a working open poll as the create screen would send it", () => {
        const db = openDb(":memory:");
        const { id } = createSession(db, {
          title: t.title, subtitle: t.prompt, method: t.method, mode: "poll", deadline: T0 + t.closesInDays * 86_400_000,
          options: t.options, groups: t.groups, settings: t.votesPerPerson ? { votesPerPerson: t.votesPerPerson } : undefined,
        }, T0);
        expect(getSettings(db, id)).toMatchObject({ method: t.method, mode: "poll", phase: "voting", votesPerPerson: t.votesPerPerson ?? 3 });
        expect(listIdeas(db, id)).toHaveLength(t.options.length);
        expect(listColumns(db, id).filter((c) => c.kind === "normal")).toHaveLength(t.groups?.length ?? 0);
      });
    });
  }
});
