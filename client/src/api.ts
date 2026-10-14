export interface Column {
  id: number;
  name: string;
  description: string;
  color: string;
  kind: "normal" | "group";
}
export interface Idea {
  id: number;
  columnId: number;
  code: string;
  audience: string;
  title: string;
  summary: string;
  details: string;
}
export interface FacilitatorIdea extends Idea {
  author: string | null;
}
export interface BoardMeta {
  id: string;
  title: string;
  subtitle: string;
  bg: string;
}

export type Phase = "setup" | "voting" | "locked" | "revealed";
export interface Timer {
  durationSec: number | null;
  state: "stopped" | "running" | "paused" | "ended";
  endsAt: number | null;
  remainingMs: number | null;
}
export interface Settings {
  votesPerPerson: number;
  ideasOpen: boolean;
  ideasPerPerson: number;
  namedResults: boolean;
  autoLock: boolean;
  phase: Phase;
  locked: boolean;
  revealed: boolean;
  timer: Timer;
}
export interface Board {
  serverNow: number;
  board: BoardMeta;
  settings: Settings;
  columns: Column[];
  ideas: Idea[];
  me: { name: string; votes: number[]; ideasAdded: number; submitted: boolean } | null;
}
export interface Counts {
  joined: number;
  connected: number;
  submitted: number;
  /** Names of people who have not pressed Submit. */
  pending: string[];
}
export interface FacilitatorState {
  serverNow: number;
  board: BoardMeta;
  settings: Settings;
  columns: Column[];
  ideas: FacilitatorIdea[];
  counts: Counts;
}

export interface ResultRow {
  id: number;
  column: string;
  columnId: number;
  code: string;
  audience: string;
  title: string;
  summary: string;
  stars: number;
  rank: number;
  tied: boolean;
  voters?: string[];
}
export interface Results {
  named: boolean;
  restored: boolean;
  totals: { joined: number; submitted: number; voted: number; stars: number };
  rows: ResultRow[];
}

export type Push =
  | { type: "ideas"; ideas: Idea[] }
  | { type: "votes"; votes: number[] }
  | { type: "refresh" }
  | { type: "deleted" }
  | { type: "nudge" }
  | ({ type: "counts" } & Counts);

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ---- what this browser remembers -----------------------------------------------------------

const tokenKey = (sid: string) => `brainstorm.token.${sid}`;
const adminKey = (sid: string) => `brainstorm.admin.${sid}`;
const BOARDS_KEY = "brainstorm.boards";

export const getToken = (sid: string) => localStorage.getItem(tokenKey(sid)) ?? "";
export const getAdminKey = (sid: string) => localStorage.getItem(adminKey(sid)) ?? "";
export const setAdminKey = (sid: string, key: string) => localStorage.setItem(adminKey(sid), key);
export const forgetAdminKey = (sid: string) => localStorage.removeItem(adminKey(sid));

/** Boards this browser can facilitate (keys live in localStorage on this device only). */
export function myBoards(): { id: string; title: string }[] {
  try {
    const list = JSON.parse(localStorage.getItem(BOARDS_KEY) ?? "[]") as { id: string; title: string }[];
    return list.filter((b) => getAdminKey(b.id));
  } catch {
    return [];
  }
}
export function rememberBoard(id: string, title: string) {
  const rest = myBoards().filter((b) => b.id !== id);
  localStorage.setItem(BOARDS_KEY, JSON.stringify([{ id, title }, ...rest].slice(0, 30)));
}

/** Sessions this browser has joined as a participant, so people can find their way back. */
const JOINED_KEY = "brainstorm.joined";
export function joinedSessions(): { id: string; title: string }[] {
  try {
    const list = JSON.parse(localStorage.getItem(JOINED_KEY) ?? "[]") as { id: string; title: string }[];
    return list.filter((b) => getToken(b.id));
  } catch {
    return [];
  }
}
export function rememberJoined(id: string, title: string) {
  const rest = joinedSessions().filter((b) => b.id !== id);
  localStorage.setItem(JOINED_KEY, JSON.stringify([{ id, title }, ...rest].slice(0, 30)));
}
/** Forget a session on this device only. Nothing is deleted from the server. */
export function forgetJoined(id: string) {
  localStorage.removeItem(tokenKey(id));
}

export interface BoardSummary {
  id: string;
  title: string;
  phase: Phase;
  ideas: number;
  joined: number;
  submitted: number;
  createdAt: number;
  lastActive: number;
}

async function call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "error", data.message ?? "Something went wrong.");
  return data as T;
}

// ---- live updates --------------------------------------------------------------------------

/**
 * Keeps a WebSocket open, reconnecting with backoff. `onOpen` fires on every (re)connect, which is
 * where callers refetch their state so nothing missed while offline is lost.
 */
export function connectLive(
  sid: string,
  who: "participant" | "facilitator",
  handlers: { onPush: (m: Push) => void; onOpen: () => void; onStatus: (online: boolean) => void },
) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout>;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const cred = who === "facilitator" ? `admin=${encodeURIComponent(getAdminKey(sid))}` : `token=${encodeURIComponent(getToken(sid))}`;
    ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sid)}&${cred}`);
    ws.onopen = () => {
      delay = 500;
      handlers.onStatus(true);
      handlers.onOpen();
    };
    ws.onmessage = (e) => handlers.onPush(JSON.parse(e.data));
    ws.onclose = () => {
      handlers.onStatus(false);
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();

  // Phones often drop sockets in the background; reconnect as soon as the tab is visible again.
  const onVisible = () => {
    if (document.visibilityState === "visible" && ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      clearTimeout(timer);
      open();
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    ws?.close();
  };
}

// ---- public --------------------------------------------------------------------------------

export const createBoard = (input: { title: string; subtitle: string; template: "blank" | "example" }) =>
  call<{ id: string; adminKey: string }>("POST", "/api/sessions", {}, input);
/** Rebuild a board from a results CSV downloaded earlier. The new board opens with the results showing. */
export const restoreResults = (title: string, csv: string) =>
  call<{ id: string; adminKey: string; ideas: number; skipped: number; named: boolean }>("POST", "/api/sessions/restore", {}, { title, csv });
export const boardExists = (sid: string) => call<{ title: string }>("GET", `/api/s/${encodeURIComponent(sid)}/exists`, {});

// ---- participant ---------------------------------------------------------------------------

const pHeaders = (sid: string) => ({ "x-participant-token": getToken(sid) });
export const fetchBoard = (sid: string) => call<Board>("GET", `/api/s/${sid}/board`, pHeaders(sid));
export async function join(sid: string, name: string) {
  const r = await call<{ token: string; name: string }>("POST", `/api/s/${sid}/join`, {}, { name, token: getToken(sid) });
  localStorage.setItem(tokenKey(sid), r.token);
  return r;
}
export const setVote = (sid: string, ideaId: number, starred: boolean) =>
  call<{ votes: number[] }>("PUT", `/api/s/${sid}/votes/${ideaId}`, pHeaders(sid), { starred });
export const setSubmitted = (sid: string, submitted: boolean) =>
  call<{ submitted: boolean }>("PUT", `/api/s/${sid}/submitted`, pHeaders(sid), { submitted });
export const suggestIdea = (sid: string, idea: { title: string; summary: string }) =>
  call<{ idea: Idea }>("POST", `/api/s/${sid}/ideas`, pHeaders(sid), idea);

// ---- facilitator ---------------------------------------------------------------------------

const aHeaders = (sid: string) => ({ "x-admin-key": getAdminKey(sid) });
const A = (sid: string, path: string) => `/api/s/${sid}/admin/${path}`;

export type IdeaInput = Partial<Pick<Idea, "columnId" | "title" | "summary" | "details" | "audience" | "code">>;
export type ColumnInput = Partial<Pick<Column, "name" | "description" | "color">>;

export const adminSummary = (sid: string) => call<BoardSummary>("GET", `/api/s/${sid}/admin/summary`, aHeaders(sid));
export const adminDeleteBoard = (sid: string) => call<{ ok: true }>("DELETE", `/api/s/${sid}` + "/admin", aHeaders(sid));
export const adminRemind = (sid: string) => call<{ reminded: number }>("POST", A(sid, "remind"), aHeaders(sid));
export const adminState = (sid: string) => call<FacilitatorState>("GET", A(sid, "state"), aHeaders(sid));
export const adminBoard = (sid: string, patch: Partial<Pick<BoardMeta, "title" | "subtitle" | "bg">>) =>
  call<{ ok: true }>("PUT", A(sid, "board"), aHeaders(sid), patch);
export const adminSettings = (sid: string, patch: Record<string, unknown>) => call<{ ok: true }>("PUT", A(sid, "settings"), aHeaders(sid), patch);
export const adminAction = (sid: string, action: string, seconds?: number) =>
  call<{ ok: true }>("POST", A(sid, "action"), aHeaders(sid), { action, seconds });
export const adminAddColumn = (sid: string, c: ColumnInput) => call<{ column: Column }>("POST", A(sid, "columns"), aHeaders(sid), c);
export const adminEditColumn = (sid: string, id: number, c: ColumnInput) => call<{ column: Column }>("PUT", A(sid, `columns/${id}`), aHeaders(sid), c);
export const adminDeleteColumn = (sid: string, id: number) => call<{ ok: true }>("DELETE", A(sid, `columns/${id}`), aHeaders(sid));
export const adminMoveColumn = (sid: string, id: number, direction: "left" | "right") =>
  call<{ ok: true }>("POST", A(sid, `columns/${id}/move`), aHeaders(sid), { direction });
export const adminAddIdea = (sid: string, i: IdeaInput) => call<{ idea: Idea }>("POST", A(sid, "ideas"), aHeaders(sid), i);
export const adminEditIdea = (sid: string, id: number, i: IdeaInput) => call<{ idea: Idea }>("PUT", A(sid, `ideas/${id}`), aHeaders(sid), i);
export const adminDeleteIdea = (sid: string, id: number) => call<{ ok: true }>("DELETE", A(sid, `ideas/${id}`), aHeaders(sid));
export const adminMerge = (sid: string, from: number, into: number) => call<{ ok: true }>("POST", A(sid, "ideas-merge"), aHeaders(sid), { from, into });
export const adminImport = (sid: string, format: "csv" | "json", content: string, mode: "append" | "replace") =>
  call<{ added: number; skipped: number; columnsAdded: number }>("POST", A(sid, "import"), aHeaders(sid), { format, content, mode });
export const adminExport = (sid: string) => call<unknown>("GET", A(sid, "export"), aHeaders(sid));
export const adminResults = (sid: string) => call<Results>("GET", A(sid, "results"), aHeaders(sid));

/** Download the results as a CSV file (the server builds it, so formulas in idea titles are neutralised). */
export async function downloadResultsCsv(sid: string, title: string) {
  const res = await fetch(A(sid, "results.csv"), { headers: aHeaders(sid) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "error", data.message ?? "Could not export the results.");
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session"}-results.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
