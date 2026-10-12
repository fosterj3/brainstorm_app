import { openDb } from "./db";
import { createColumn, createIdea } from "./ideas";
import { createSession } from "./sessions";

/** A fresh in-memory database with one session, one column and `n` ideas (ids 1..n). */
export function newBoard(n = 6) {
  const db = openDb(":memory:");
  const { id: sid, adminKey } = createSession(db, { title: "Test board" }, 0);
  const col = createColumn(db, sid, { name: "Alpha" });
  const ideas = Array.from({ length: n }, (_, i) => createIdea(db, sid, { columnId: col.id, title: `Idea ${i + 1}` }));
  return { db, sid, adminKey, col, ideas };
}
