import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "./db";
import { createIdea, deleteIdea, importIdeas, listIdeasForFacilitator, mergeIdeas, parseCsv, parseIdeas, updateIdea } from "./ideas";
import { VoteError, addIdea, getVotes, join, listIdeas, setSetting, setVote } from "./votes";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

describe("CSV and JSON parsing", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    const rows = parseCsv('title,description\r\n"Hello, world","She said ""hi""\nthere"\r\nPlain,Text\r\n');
    expect(rows).toEqual([["title", "description"], ["Hello, world", 'She said "hi"\nthere'], ["Plain", "Text"]]);
  });
  it("maps columns by header name, in any order, ignoring a BOM", () => {
    const rows = parseIdeas("csv", "﻿Theme,Title,Description\nPeople,Mentoring,Pair up\n");
    expect(rows).toEqual([{ title: "Mentoring", description: "Pair up", theme: "People" }]);
  });
  it("requires a title column", () => {
    expect(code(() => parseIdeas("csv", "foo,bar\n1,2"))).toBe("bad_input");
  });
  it("accepts a JSON array, an {ideas} object, or plain strings", () => {
    expect(parseIdeas("json", '[{"title":"A"}]')).toHaveLength(1);
    expect(parseIdeas("json", '{"ideas":[{"title":"A"},"B"]}')).toHaveLength(2);
    expect(code(() => parseIdeas("json", "{nope"))).toBe("bad_input");
    expect(code(() => parseIdeas("json", '{"a":1}'))).toBe("bad_input");
  });
});

describe("import", () => {
  it("adds valid rows, skips blank titles, and groups themes case-insensitively", () => {
    const result = importIdeas(db, [{ title: "A", theme: "People" }, { title: " " }, { title: "B", theme: "people" }], "append");
    expect(result).toEqual({ added: 2, skipped: 1 });
    expect(listIdeas(db).map((i) => i.theme)).toEqual(["People", "People"]);
  });
  it("replaces the board only before voting starts", () => {
    importIdeas(db, [{ title: "Old" }], "append");
    importIdeas(db, [{ title: "New" }], "replace");
    expect(listIdeas(db).map((i) => i.title)).toEqual(["New"]);
    setSetting(db, "phase", "voting");
    expect(code(() => importIdeas(db, [{ title: "Newer" }], "replace"))).toBe("bad_state");
  });
  it("is all-or-nothing when the limit is exceeded", () => {
    const rows = Array.from({ length: 301 }, (_, i) => ({ title: `I${i}` }));
    expect(code(() => importIdeas(db, rows, "append"))).toBe("bad_input");
    expect(listIdeas(db)).toHaveLength(0);
  });
});

describe("editing, deleting and merging", () => {
  it("edits and deletes", () => {
    const a = createIdea(db, { title: "A" });
    updateIdea(db, a.id, { title: "A2", description: "d", theme: "T" });
    expect(listIdeas(db)[0]).toMatchObject({ title: "A2", theme: "T" });
    deleteIdea(db, a.id);
    expect(listIdeas(db)).toHaveLength(0);
    expect(code(() => deleteIdea(db, a.id))).toBe("unknown_idea");
  });
  it("deleting an idea returns its stars to the voters", () => {
    const [a, b] = [createIdea(db, { title: "A" }), createIdea(db, { title: "B" })];
    const alex = join(db, "Alex").token;
    setSetting(db, "phase", "voting");
    setSetting(db, "votes_per_person", 1);
    setVote(db, alex, a.id, true);
    deleteIdea(db, a.id);
    expect(getVotes(db, alex)).toEqual([]);
    expect(() => setVote(db, alex, b.id, true)).not.toThrow();
  });
  it("merging moves stars across and never leaves anyone over the cap", () => {
    const [a, b] = [createIdea(db, { title: "A" }), createIdea(db, { title: "B" })];
    const [alex, sam, kim] = [join(db, "Alex").token, join(db, "Sam").token, join(db, "Kim").token];
    setSetting(db, "phase", "voting");
    setVote(db, alex, a.id, true);
    setVote(db, sam, a.id, true);
    setVote(db, sam, b.id, true); // starred both duplicates
    setVote(db, kim, b.id, true);
    mergeIdeas(db, a.id, b.id);
    expect(listIdeas(db).map((i) => i.id)).toEqual([b.id]);
    expect(getVotes(db, alex)).toEqual([b.id]);
    expect(getVotes(db, sam)).toEqual([b.id]);
    expect(getVotes(db, kim)).toEqual([b.id]);
    expect(code(() => mergeIdeas(db, b.id, b.id))).toBe("bad_input");
  });
  it("shows the facilitator who suggested an idea, but participants never see it", () => {
    const alex = join(db, "Alex").token;
    addIdea(db, alex, { title: "Mine" });
    expect(listIdeasForFacilitator(db)[0].author).toBe("Alex");
    expect(JSON.stringify(listIdeas(db))).not.toContain("Alex");
  });
});
