import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "./db";
import {
  VoteError, addIdea, countIdeasBy, getCounts, getSettings, getVotes, insertIdeas, join, listIdeas, setSetting, setSubmitted, setVote,
} from "./votes";

let db: DB;
let token: string;

beforeEach(() => {
  db = openDb(":memory:");
  insertIdeas(db, Array.from({ length: 6 }, (_, i) => ({ title: `Idea ${i + 1}` })));
  token = join(db, "Alex").token;
  setSetting(db, "phase", "voting");
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as VoteError).code;
  }
  return null;
};

describe("vote cap", () => {
  it("allows up to the cap and rejects the next star", () => {
    setVote(db, token, 1, true);
    setVote(db, token, 2, true);
    setVote(db, token, 3, true);
    expect(code(() => setVote(db, token, 4, true))).toBe("cap_reached");
    expect(getVotes(db, token)).toEqual([1, 2, 3]);
  });
  it("lets you un-star and re-star", () => {
    setVote(db, token, 1, true);
    setVote(db, token, 2, true);
    setVote(db, token, 3, true);
    setVote(db, token, 3, false);
    expect(setVote(db, token, 4, true)).toEqual([1, 2, 4]);
  });
  it("is idempotent and does not double count", () => {
    setVote(db, token, 1, true);
    setVote(db, token, 1, true);
    expect(getVotes(db, token)).toEqual([1]);
    setVote(db, token, 2, false);
    expect(getVotes(db, token)).toEqual([1]);
  });
  it("honours the facilitator setting, not a hardcoded value", () => {
    setSetting(db, "votes_per_person", 1);
    setVote(db, token, 1, true);
    expect(code(() => setVote(db, token, 2, true))).toBe("cap_reached");
    setSetting(db, "votes_per_person", 5);
    expect(getSettings(db).votesPerPerson).toBe(5);
    expect(() => setVote(db, token, 2, true)).not.toThrow();
  });
  it("tracks the cap per participant", () => {
    const other = join(db, "Sam").token;
    setVote(db, token, 1, true);
    setVote(db, token, 2, true);
    setVote(db, token, 3, true);
    expect(() => setVote(db, other, 1, true)).not.toThrow();
  });
});

describe("phase and lock", () => {
  it("refuses stars before the facilitator starts voting", () => {
    setSetting(db, "phase", "setup");
    expect(code(() => setVote(db, token, 1, true))).toBe("not_started");
  });
  it("rejects stars and un-stars once locked, keeping existing votes", () => {
    setVote(db, token, 1, true);
    setSetting(db, "phase", "locked");
    expect(code(() => setVote(db, token, 2, true))).toBe("locked");
    expect(code(() => setVote(db, token, 1, false))).toBe("locked");
    expect(getVotes(db, token)).toEqual([1]);
  });
  it("accepts votes again when reopened", () => {
    setSetting(db, "phase", "locked");
    setSetting(db, "phase", "voting");
    expect(() => setVote(db, token, 1, true)).not.toThrow();
  });
});

describe("validation and identity", () => {
  it("rejects unknown ideas and participants", () => {
    expect(code(() => setVote(db, token, 999, true))).toBe("unknown_idea");
    expect(code(() => setVote(db, "nope", 1, true))).toBe("unknown_participant");
  });
  it("resumes with a matching token and rejects a taken name without it", () => {
    expect(join(db, "alex", token).token).toBe(token);
    expect(code(() => join(db, " ALEX "))).toBe("name_taken");
    expect(code(() => join(db, "  "))).toBe("name_required");
  });
});

describe("submitted count", () => {
  it("counts people who submitted, not what they picked", () => {
    const sam = join(db, "Sam").token;
    setVote(db, token, 1, true);
    setSubmitted(db, token, true);
    expect(getCounts(db)).toEqual({ joined: 2, submitted: 1 });
    expect(Object.keys(getCounts(db))).toEqual(["joined", "submitted"]);
    expect(code(() => setSubmitted(db, sam, true))).toBe("nothing_to_submit");
  });
  it("can be undone, and is refused outside the voting phase", () => {
    setVote(db, token, 1, true);
    setSubmitted(db, token, true);
    setSubmitted(db, token, false);
    expect(getCounts(db).submitted).toBe(0);
    setSetting(db, "phase", "locked");
    expect(code(() => setSubmitted(db, token, true))).toBe("locked");
    setSetting(db, "phase", "setup");
    expect(code(() => setSubmitted(db, token, true))).toBe("not_started");
  });
});

describe("participant-suggested ideas", () => {
  beforeEach(() => setSetting(db, "phase", "setup"));

  it("adds an idea and counts it against the author", () => {
    const idea = addIdea(db, token, { title: "  New   idea ", description: "Why", theme: "People" });
    expect(idea.title).toBe("New idea");
    expect(listIdeas(db).some((i) => i.id === idea.id)).toBe(true);
    expect(countIdeasBy(db, token)).toBe(1);
  });
  it("never exposes the author in the idea list", () => {
    addIdea(db, token, { title: "Mine" });
    expect(JSON.stringify(listIdeas(db))).not.toContain(token);
  });
  it("enforces the per-person limit from settings", () => {
    setSetting(db, "ideas_per_person", 2);
    addIdea(db, token, { title: "A" });
    addIdea(db, token, { title: "B" });
    expect(code(() => addIdea(db, token, { title: "C" }))).toBe("idea_limit");
    expect(() => addIdea(db, join(db, "Sam").token, { title: "C" })).not.toThrow();
  });
  it("is refused when switched off or once voting has started", () => {
    setSetting(db, "ideas_open", false);
    expect(code(() => addIdea(db, token, { title: "A" }))).toBe("ideas_closed");
    setSetting(db, "ideas_open", true);
    setSetting(db, "phase", "voting");
    expect(code(() => addIdea(db, token, { title: "A" }))).toBe("ideas_closed");
  });
  it("requires a title and a known participant", () => {
    expect(code(() => addIdea(db, token, { title: "   " }))).toBe("invalid_idea");
    expect(code(() => addIdea(db, "nope", { title: "A" }))).toBe("unknown_participant");
  });
  it("reuses the spelling of an existing theme", () => {
    addIdea(db, token, { title: "A", theme: "People" });
    const b = addIdea(db, join(db, "Sam").token, { title: "B", theme: "people" });
    expect(b.theme).toBe("People");
  });
  it("lets a suggested idea be starred like any other", () => {
    const idea = addIdea(db, token, { title: "A" });
    setSetting(db, "phase", "voting");
    expect(setVote(db, token, idea.id, true)).toContain(idea.id);
  });
});
