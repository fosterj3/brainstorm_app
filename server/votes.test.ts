import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "./db";
import { newBoard } from "./testutil";
import { listIdeas } from "./ideas";
import {
  VoteError, addIdea, countIdeasBy, getCounts, getSettings, getVotes, join, setSetting, setSubmitted, setVote,
} from "./votes";

let db: DB;
let sid: string;
let token: string;

beforeEach(() => {
  ({ db, sid } = newBoard(6));
  token = join(db, sid, "Alex").token;
  setSetting(db, sid, "phase", "voting");
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
    setVote(db, sid, token, 1, true);
    setVote(db, sid, token, 2, true);
    setVote(db, sid, token, 3, true);
    expect(code(() => setVote(db, sid, token, 4, true))).toBe("cap_reached");
    expect(getVotes(db, sid, token)).toEqual([1, 2, 3]);
  });
  it("lets you un-star and re-star", () => {
    setVote(db, sid, token, 1, true);
    setVote(db, sid, token, 2, true);
    setVote(db, sid, token, 3, true);
    setVote(db, sid, token, 3, false);
    expect(setVote(db, sid, token, 4, true)).toEqual([1, 2, 4]);
  });
  it("is idempotent and does not double count", () => {
    setVote(db, sid, token, 1, true);
    setVote(db, sid, token, 1, true);
    expect(getVotes(db, sid, token)).toEqual([1]);
    setVote(db, sid, token, 2, false);
    expect(getVotes(db, sid, token)).toEqual([1]);
  });
  it("honours the facilitator setting, not a hardcoded value", () => {
    setSetting(db, sid, "votes_per_person", 1);
    setVote(db, sid, token, 1, true);
    expect(code(() => setVote(db, sid, token, 2, true))).toBe("cap_reached");
    setSetting(db, sid, "votes_per_person", 5);
    expect(getSettings(db, sid).votesPerPerson).toBe(5);
    expect(() => setVote(db, sid, token, 2, true)).not.toThrow();
  });
  it("tracks the cap per participant", () => {
    const other = join(db, sid, "Sam").token;
    setVote(db, sid, token, 1, true);
    setVote(db, sid, token, 2, true);
    setVote(db, sid, token, 3, true);
    expect(() => setVote(db, sid, other, 1, true)).not.toThrow();
  });
});

describe("phase and lock", () => {
  it("refuses stars before the facilitator starts voting", () => {
    setSetting(db, sid, "phase", "setup");
    expect(code(() => setVote(db, sid, token, 1, true))).toBe("not_started");
  });
  it("rejects stars and un-stars once locked, keeping existing votes", () => {
    setVote(db, sid, token, 1, true);
    setSetting(db, sid, "phase", "locked");
    expect(code(() => setVote(db, sid, token, 2, true))).toBe("locked");
    expect(code(() => setVote(db, sid, token, 1, false))).toBe("locked");
    expect(getVotes(db, sid, token)).toEqual([1]);
  });
  it("accepts votes again when reopened", () => {
    setSetting(db, sid, "phase", "locked");
    setSetting(db, sid, "phase", "voting");
    expect(() => setVote(db, sid, token, 1, true)).not.toThrow();
  });
});

describe("validation and identity", () => {
  it("rejects unknown ideas and participants", () => {
    expect(code(() => setVote(db, sid, token, 999, true))).toBe("unknown_idea");
    expect(code(() => setVote(db, sid, "nope", 1, true))).toBe("unknown_participant");
  });
  it("resumes with a matching token and rejects a taken name without it", () => {
    expect(join(db, sid, "alex", token).token).toBe(token);
    expect(code(() => join(db, sid, " ALEX "))).toBe("name_taken");
    expect(code(() => join(db, sid, "  "))).toBe("name_required");
  });
});

describe("submitted count", () => {
  it("counts people who submitted, not what they picked", () => {
    const sam = join(db, sid, "Sam").token;
    setVote(db, sid, token, 1, true);
    setSubmitted(db, sid, token, true);
    expect(getCounts(db, sid)).toEqual({ joined: 2, submitted: 1 });
    expect(Object.keys(getCounts(db, sid))).toEqual(["joined", "submitted"]);
    expect(code(() => setSubmitted(db, sid, sam, true))).toBe("nothing_to_submit");
  });
  it("can be undone, and is refused outside the voting phase", () => {
    setVote(db, sid, token, 1, true);
    setSubmitted(db, sid, token, true);
    setSubmitted(db, sid, token, false);
    expect(getCounts(db, sid).submitted).toBe(0);
    setSetting(db, sid, "phase", "locked");
    expect(code(() => setSubmitted(db, sid, token, true))).toBe("locked");
    setSetting(db, sid, "phase", "setup");
    expect(code(() => setSubmitted(db, sid, token, true))).toBe("not_started");
  });
});

describe("participant-suggested ideas", () => {
  beforeEach(() => setSetting(db, sid, "phase", "setup"));

  it("adds an idea and counts it against the author", () => {
    const idea = addIdea(db, sid, token, { title: "  New   idea ", summary: "Why" });
    expect(idea.title).toBe("New idea");
    expect(listIdeas(db, sid).some((i) => i.id === idea.id)).toBe(true);
    expect(countIdeasBy(db, sid, token)).toBe(1);
  });
  it("never exposes the author in the idea list", () => {
    addIdea(db, sid, token, { title: "Mine" });
    expect(JSON.stringify(listIdeas(db, sid))).not.toContain(token);
  });
  it("enforces the per-person limit from settings", () => {
    setSetting(db, sid, "ideas_per_person", 2);
    addIdea(db, sid, token, { title: "A" });
    addIdea(db, sid, token, { title: "B" });
    expect(code(() => addIdea(db, sid, token, { title: "C" }))).toBe("idea_limit");
    expect(() => addIdea(db, sid, join(db, sid, "Sam").token, { title: "C" })).not.toThrow();
  });
  it("is refused when switched off or once voting has started", () => {
    setSetting(db, sid, "ideas_open", false);
    expect(code(() => addIdea(db, sid, token, { title: "A" }))).toBe("ideas_closed");
    setSetting(db, sid, "ideas_open", true);
    setSetting(db, sid, "phase", "voting");
    expect(code(() => addIdea(db, sid, token, { title: "A" }))).toBe("ideas_closed");
  });
  it("requires a title and a known participant", () => {
    expect(code(() => addIdea(db, sid, token, { title: "   " }))).toBe("invalid_idea");
    expect(code(() => addIdea(db, sid, "nope", { title: "A" }))).toBe("unknown_participant");
  });
  it("puts suggestions in the group column", () => {
    const idea = addIdea(db, sid, token, { title: "A" });
    const group = db.prepare("SELECT id FROM columns WHERE session_id = ? AND kind = 'group'").get(sid) as { id: number };
    expect(idea.columnId).toBe(group.id);
  });
  it("lets a suggested idea be starred like any other", () => {
    const idea = addIdea(db, sid, token, { title: "A" });
    setSetting(db, sid, "phase", "voting");
    expect(setVote(db, sid, token, idea.id, true)).toContain(idea.id);
  });
});
