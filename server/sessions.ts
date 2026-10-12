import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { VoteError } from "./errors";
import { createGroupColumn, cleanColor, importBoard, parseIdeas } from "./ideas";

export const MAX_SESSIONS = 5000;
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no look-alike characters
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export interface BoardMeta {
  id: string;
  title: string;
  subtitle: string;
  bg: string;
}

const clip = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Create a board. The caller gets the public session code (for the participant link) and a secret admin key
 * (for the facilitator link). Only a hash of the admin key is stored.
 */
export function createSession(
  db: DB,
  input: { title?: string; subtitle?: string; template?: string },
  now = Date.now(),
): { id: string; adminKey: string } {
  const title = clip(input.title, 100);
  if (!title) throw new VoteError("bad_input", "Please give your session a title.");
  return db.transaction(() => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    if (n >= MAX_SESSIONS) throw new VoteError("full", "This site is at capacity. Please try again later.");

    let id = "";
    do {
      id = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id));

    const adminKey = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO sessions (id, admin_hash, title, subtitle, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, hash(adminKey), title, clip(input.subtitle, 200), now, now,
    );
    createGroupColumn(db, id);
    if (input.template === "example") {
      const file = path.resolve(import.meta.dirname, "../ideas.example.json");
      importBoard(db, id, parseIdeas("json", fs.readFileSync(file, "utf8")), "append");
    }
    return { id, adminKey };
  })();
}

export function getBoardMeta(db: DB, sid: string): BoardMeta | null {
  return (db.prepare("SELECT id, title, subtitle, bg FROM sessions WHERE id = ?").get(sid) as BoardMeta | undefined) ?? null;
}

export function verifyAdmin(db: DB, sid: string, key: string | undefined | null): boolean {
  if (!key) return false;
  const row = db.prepare("SELECT admin_hash FROM sessions WHERE id = ?").get(sid) as { admin_hash: string } | undefined;
  if (!row) return false;
  const a = Buffer.from(hash(key));
  const b = Buffer.from(row.admin_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function updateBoardMeta(db: DB, sid: string, patch: { title?: string; subtitle?: string; bg?: string }) {
  db.transaction(() => {
    const cur = getBoardMeta(db, sid);
    if (!cur) throw new VoteError("unknown_session", "That session no longer exists.");
    const title = patch.title === undefined ? cur.title : clip(patch.title, 100);
    if (!title) throw new VoteError("bad_input", "The title cannot be empty.");
    const subtitle = patch.subtitle === undefined ? cur.subtitle : clip(patch.subtitle, 200);
    const bg = patch.bg === undefined ? cur.bg : cleanColor(patch.bg);
    db.prepare("UPDATE sessions SET title = ?, subtitle = ?, bg = ? WHERE id = ?").run(title, subtitle, bg, sid);
  })();
}

export function touch(db: DB, sid: string, now = Date.now()) {
  db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(now, sid);
}

/** Delete sessions nobody has used for a while, with everything in them. Returns how many were removed. */
export function purgeIdle(db: DB, now: number, maxIdleMs: number): number {
  return db.prepare("DELETE FROM sessions WHERE last_active < ?").run(now - maxIdleMs).changes;
}

export function sessionsWithRunningTimer(db: DB): string[] {
  return (db.prepare("SELECT session_id FROM settings WHERE key = 'timer_state' AND value = 'running'").all() as { session_id: string }[]).map((r) => r.session_id);
}
