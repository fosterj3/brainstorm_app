import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "./db";
import {
  createColumn, createIdea, deleteColumn, deleteIdea, exportBoard, importBoard, listColumns, listIdeas, listIdeasForFacilitator,
  mergeIdeas, moveColumn, parseCsv, parseIdeas, updateColumn, updateIdea,
} from "./ideas";
import { createSession } from "./sessions";
import { newBoard } from "./testutil";
import { VoteError, addIdea, getVotes, join, setSetting, setVote } from "./votes";

let db: DB;
let sid: string;
let colId: number;

beforeEach(() => {
  ({ db, sid } = newBoard(0));
  colId = listColumns(db, sid).find((c) => c.kind === "normal")!.id;
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

describe("columns", () => {
  it("creates an ungrouped section with every poll, always listed last", () => {
    createColumn(db, sid, { name: "Beta" });
    const cols = listColumns(db, sid);
    expect(cols.map((c) => c.name)).toEqual(["Alpha", "Beta", "Other options"]);
    expect(cols.at(-1)!.kind).toBe("group");
  });
  it("gives new columns distinct default colors and accepts custom ones", () => {
    const a = createColumn(db, sid, { name: "A" });
    const b = createColumn(db, sid, { name: "B", color: "#112233" });
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.color).toBe("#112233");
    expect(code(() => createColumn(db, sid, { name: "C", color: "red" }))).toBe("bad_input");
  });
  it("renames, recolors and reorders", () => {
    const b = createColumn(db, sid, { name: "Beta" });
    updateColumn(db, sid, b.id, { name: "Beta 2", color: "#abcdef", description: "d" });
    expect(listColumns(db, sid).find((c) => c.id === b.id)).toMatchObject({ name: "Beta 2", color: "#abcdef", description: "d" });
    moveColumn(db, sid, b.id, "left");
    expect(listColumns(db, sid).map((c) => c.name)).toEqual(["Beta 2", "Alpha", "Other options"]);
    moveColumn(db, sid, b.id, "left"); // already first: no-op
    expect(listColumns(db, sid)[0].name).toBe("Beta 2");
  });
  it("deleting a column removes its ideas and stars, but the group column is protected", () => {
    const idea = createIdea(db, sid, { columnId: colId, title: "A" });
    const alex = join(db, sid, "Alex").token;
    setSetting(db, sid, "phase", "voting");
    setVote(db, sid, alex, idea.id, true);
    deleteColumn(db, sid, colId);
    expect(listIdeas(db, sid)).toHaveLength(0);
    expect(getVotes(db, sid, alex)).toEqual([]);
    const group = listColumns(db, sid).find((c) => c.kind === "group")!;
    expect(code(() => deleteColumn(db, sid, group.id))).toBe("bad_state");
  });
  it("limits the number of columns", () => {
    for (let i = 0; i < 19; i++) createColumn(db, sid, { name: `C${i}` });
    expect(code(() => createColumn(db, sid, { name: "one too many" }))).toBe("bad_input");
  });
});

describe("ideas", () => {
  it("does not invent codes, but keeps any code the organizer types", () => {
    const [a, b] = [createIdea(db, sid, { columnId: colId, title: "A" }), createIdea(db, sid, { columnId: colId, title: "B" })];
    expect([a.code, b.code]).toEqual(["", ""]);
    expect(createIdea(db, sid, { columnId: colId, title: "C", code: "X9" }).code).toBe("X9");
  });
  it("stores summary, details and audience, and edits or moves them", () => {
    const col2 = createColumn(db, sid, { name: "Beta" });
    const idea = createIdea(db, sid, { columnId: colId, title: "T", summary: "S", details: "Line 1\nLine 2", audience: "For managers" });
    expect(listIdeas(db, sid)[0]).toMatchObject({ summary: "S", details: "Line 1\nLine 2", audience: "For managers" });
    updateIdea(db, sid, idea.id, { title: "T2", columnId: col2.id });
    expect(listIdeas(db, sid)[0]).toMatchObject({ title: "T2", columnId: col2.id, summary: "S", audience: "For managers" });
    expect(code(() => updateIdea(db, sid, idea.id, { columnId: 9999 }))).toBe("unknown_column");
  });
  it("requires a title", () => {
    expect(code(() => createIdea(db, sid, { columnId: colId, title: "  " }))).toBe("invalid_idea");
  });
  it("shows the facilitator who suggested an idea, but participants never see it", () => {
    const alex = join(db, sid, "Alex").token;
    addIdea(db, sid, alex, { title: "Mine" });
    expect(listIdeasForFacilitator(db, sid)[0].author).toBe("Alex");
    expect(JSON.stringify(listIdeas(db, sid))).not.toContain("Alex");
    expect(JSON.stringify(listIdeas(db, sid))).not.toContain(alex);
  });
  it("deleting an idea returns its stars to the voters", () => {
    const [a, b] = [createIdea(db, sid, { columnId: colId, title: "A" }), createIdea(db, sid, { columnId: colId, title: "B" })];
    const alex = join(db, sid, "Alex").token;
    setSetting(db, sid, "phase", "voting");
    setSetting(db, sid, "votes_per_person", 1);
    setVote(db, sid, alex, a.id, true);
    deleteIdea(db, sid, a.id);
    expect(getVotes(db, sid, alex)).toEqual([]);
    expect(() => setVote(db, sid, alex, b.id, true)).not.toThrow();
    expect(code(() => deleteIdea(db, sid, a.id))).toBe("unknown_idea");
  });
  it("merging moves stars across and never leaves anyone over the cap", () => {
    const [a, b] = [createIdea(db, sid, { columnId: colId, title: "A" }), createIdea(db, sid, { columnId: colId, title: "B" })];
    const [alex, sam, kim] = [join(db, sid, "Alex").token, join(db, sid, "Sam").token, join(db, sid, "Kim").token];
    setSetting(db, sid, "phase", "voting");
    setVote(db, sid, alex, a.id, true);
    setVote(db, sid, sam, a.id, true);
    setVote(db, sid, sam, b.id, true); // starred both duplicates
    setVote(db, sid, kim, b.id, true);
    mergeIdeas(db, sid, a.id, b.id);
    expect(listIdeas(db, sid).map((i) => i.id)).toEqual([b.id]);
    for (const t of [alex, sam, kim]) expect(getVotes(db, sid, t)).toEqual([b.id]);
    expect(code(() => mergeIdeas(db, sid, b.id, b.id))).toBe("bad_input");
  });
});

describe("boards are isolated from each other", () => {
  it("one facilitator cannot touch another session's columns or ideas", () => {
    const other = createSession(db, { title: "Other" }, 0).id;
    const theirs = createColumn(db, other, { name: "Theirs" });
    const idea = createIdea(db, other, { columnId: theirs.id, title: "Theirs" });
    expect(code(() => updateIdea(db, sid, idea.id, { title: "hacked" }))).toBe("unknown_idea");
    expect(code(() => deleteIdea(db, sid, idea.id))).toBe("unknown_idea");
    expect(code(() => deleteColumn(db, sid, theirs.id))).toBe("unknown_column");
    expect(code(() => createIdea(db, sid, { columnId: theirs.id, title: "x" }))).toBe("unknown_column");
    expect(code(() => mergeIdeas(db, sid, idea.id, idea.id + 1))).toBe("unknown_idea");
    expect(listIdeas(db, other)).toHaveLength(1);
  });
  it("a participant of one session cannot vote in another", () => {
    const other = createSession(db, { title: "Other" }, 0).id;
    const theirs = createColumn(db, other, { name: "Theirs" });
    const idea = createIdea(db, other, { columnId: theirs.id, title: "Theirs" });
    const alex = join(db, sid, "Alex").token;
    setSetting(db, other, "phase", "voting");
    expect(code(() => setVote(db, other, alex, idea.id, true))).toBe("unknown_participant");
    setSetting(db, sid, "phase", "voting");
    expect(code(() => setVote(db, sid, alex, idea.id, true))).toBe("unknown_idea");
  });
  it("the same name can be used in different sessions", () => {
    const other = createSession(db, { title: "Other" }, 0).id;
    expect(() => join(db, sid, "Alex")).not.toThrow();
    expect(() => join(db, other, "Alex")).not.toThrow();
  });
});

describe("CSV and JSON parsing", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    const rows = parseCsv('title,summary\r\n"Hello, world","She said ""hi""\nthere"\r\nPlain,Text\r\n');
    expect(rows).toEqual([["title", "summary"], ["Hello, world", 'She said "hi"\nthere'], ["Plain", "Text"]]);
  });
  it("maps columns by header name, in any order, with aliases and a BOM", () => {
    const { ideas } = parseIdeas("csv", "﻿Theme,Title,Description,Details,Audience,Code\nPeople,Mentoring,Pair up,Long text,For managers,P1\n");
    expect(ideas).toEqual([{ column: "People", title: "Mentoring", summary: "Pair up", details: "Long text", audience: "For managers", code: "P1" }]);
  });
  it("requires a title column", () => {
    expect(code(() => parseIdeas("csv", "foo,bar\n1,2"))).toBe("bad_input");
  });
  it("accepts a JSON list, or an object with columns and ideas, or plain strings", () => {
    expect(parseIdeas("json", '[{"title":"A"}]').ideas).toHaveLength(1);
    const full = parseIdeas("json", '{"columns":[{"name":"X"}],"ideas":[{"title":"A","theme":"X"},"B"]}');
    expect(full.columns).toHaveLength(1);
    expect(full.ideas).toHaveLength(2);
    expect(code(() => parseIdeas("json", "{nope"))).toBe("bad_input");
    expect(code(() => parseIdeas("json", '{"a":1}'))).toBe("bad_input");
  });
});

describe("import and export", () => {
  it("creates missing columns, matches existing ones case-insensitively, skips blank titles", () => {
    const r = importBoard(db, sid, parseIdeas("csv", "column,title,summary\nalpha,One,\nBeta,Two,\nBETA,Three,\n,Four,\nBeta,,no title\n"), "append");
    expect(r).toEqual({ added: 4, skipped: 1, columnsAdded: 1 }); // only Beta is new; the blank group row is ungrouped
    const names = listColumns(db, sid).map((c) => c.name);
    expect(names).toEqual(["Alpha", "Beta", "Other options"]);
    const ungrouped = listColumns(db, sid).find((c) => c.kind === "group")!;
    expect(listIdeas(db, sid).find((i) => i.title === "Four")!.columnId).toBe(ungrouped.id);
    expect(listIdeas(db, sid).find((i) => i.title === "One")!.columnId).toBe(colId);
  });
  it("imports declared columns with their colors and descriptions", () => {
    importBoard(db, sid, parseIdeas("json", '{"columns":[{"name":"Fresh","color":"#010203","description":"hi"}],"ideas":[{"column":"Fresh","title":"X"}]}'), "append");
    expect(listColumns(db, sid).find((c) => c.name === "Fresh")).toMatchObject({ color: "#010203", description: "hi" });
  });
  it("replaces the board only before voting starts, and keeps the group column", () => {
    createIdea(db, sid, { columnId: colId, title: "Old" });
    importBoard(db, sid, parseIdeas("json", '[{"title":"New","theme":"Fresh"}]'), "replace");
    expect(listIdeas(db, sid).map((i) => i.title)).toEqual(["New"]);
    expect(listColumns(db, sid).map((c) => c.name)).toEqual(["Fresh", "Other options"]);
    setSetting(db, sid, "phase", "voting");
    expect(code(() => importBoard(db, sid, parseIdeas("json", '[{"title":"X"}]'), "replace"))).toBe("bad_state");
  });
  it("is all-or-nothing when the limit is exceeded", () => {
    const ideas = Array.from({ length: 301 }, (_, i) => ({ title: `I${i}` }));
    expect(code(() => importBoard(db, sid, { columns: [], ideas }, "append"))).toBe("bad_input");
    expect(listIdeas(db, sid)).toHaveLength(0);
    expect(listColumns(db, sid).map((c) => c.name)).toEqual(["Alpha", "Other options"]);
  });
  it("round-trips through export, without any votes or people", () => {
    createIdea(db, sid, { columnId: colId, title: "A", summary: "s", details: "d", audience: "For all" });
    const alex = join(db, sid, "Alex").token;
    addIdea(db, sid, alex, { title: "Suggested" });
    const out = exportBoard(db, sid);
    expect(JSON.stringify(out)).not.toContain("Alex");
    expect(out.ideas).toHaveLength(1); // participant suggestions are not part of the template
    const fresh = newBoard(0);
    importBoard(fresh.db, fresh.sid, parseIdeas("json", JSON.stringify(out)), "replace");
    expect(exportBoard(fresh.db, fresh.sid)).toEqual(out);
  });
});

describe("groups are optional", () => {
  it("accepts the newer header and key names for options, groups and tags", () => {
    const csv = parseIdeas("csv", "Option,Group,Tag\nMentoring,People,For managers\n");
    expect(csv.ideas).toEqual([{ column: "People", title: "Mentoring", summary: "", details: "", audience: "For managers", code: "" }]);
    const json = parseIdeas("json", '{"groups":[{"name":"X"}],"options":[{"title":"A","group":"X","tag":"t"},"B"]}');
    expect(json.columns).toHaveLength(1);
    expect(json.ideas[0]).toMatchObject({ title: "A", column: "X", audience: "t" });
    expect(json.ideas).toHaveLength(2);
  });
  it("puts options without a group in the ungrouped section and lets a poll have no groups at all", () => {
    const f = newBoard(5);
    deleteColumn(f.db, f.sid, listColumns(f.db, f.sid).find((c) => c.kind === "normal")!.id);
    importBoard(f.db, f.sid, parseIdeas("json", '["One","Two"]'), "append");
    const cols = listColumns(f.db, f.sid);
    expect(cols.map((c) => c.kind)).toEqual(["group"]);
    expect(listIdeas(f.db, f.sid).map((i) => i.columnId)).toEqual([cols[0].id, cols[0].id]);
  });
  it("exports ungrouped organizer options, with a blank group", () => {
    const ungrouped = listColumns(db, sid).find((c) => c.kind === "group")!;
    createIdea(db, sid, { columnId: ungrouped.id, title: "Loose" });
    expect(exportBoard(db, sid).ideas).toEqual([expect.objectContaining({ title: "Loose", column: "" })]);
  });
});
