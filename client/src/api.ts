export interface Idea {
  id: number;
  title: string;
  description: string;
  theme: string;
}
export interface FacilitatorIdea extends Idea {
  author: string | null;
}

export type Phase = "setup" | "voting" | "locked";
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
  timer: Timer;
}
export interface Session {
  serverNow: number;
  settings: Settings;
  ideas: Idea[];
  me: { name: string; votes: number[]; ideasAdded: number; submitted: boolean } | null;
}
export interface Counts {
  joined: number;
  connected: number;
  submitted: number;
}
export interface FacilitatorState {
  serverNow: number;
  settings: Settings;
  ideas: FacilitatorIdea[];
  counts: Counts;
}

export type Push =
  | { type: "ideas"; ideas: Idea[] }
  | { type: "votes"; votes: number[] }
  | { type: "refresh" }
  | ({ type: "counts" } & Counts);

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const TOKEN_KEY = "brainstorm.token";
const FAC_KEY = "brainstorm.facilitator";
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const getFacToken = () => localStorage.getItem(FAC_KEY) ?? "";
export const setFacToken = (t: string) => (t ? localStorage.setItem(FAC_KEY, t) : localStorage.removeItem(FAC_KEY));

async function call<T>(method: string, url: string, body?: unknown, facilitator = false): Promise<T> {
  const headers: Record<string, string> = facilitator ? { "x-facilitator-token": getFacToken() } : { "x-participant-token": getToken() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "error", data.message ?? "Something went wrong.");
  return data as T;
}

/**
 * Keeps a WebSocket open, reconnecting with backoff. `onOpen` fires on every (re)connect, which is
 * where callers refetch their state so nothing missed while offline is lost.
 */
export function connectLive(
  who: "participant" | "facilitator",
  handlers: { onPush: (m: Push) => void; onOpen: () => void; onStatus: (online: boolean) => void },
) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout>;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = who === "facilitator" ? `facilitator=${encodeURIComponent(getFacToken())}` : `token=${encodeURIComponent(getToken())}`;
    ws = new WebSocket(`${proto}://${location.host}/ws?${query}`);
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

// participant
export const fetchSession = () => call<Session>("GET", "/api/session");
export async function join(name: string) {
  const r = await call<{ token: string; name: string }>("POST", "/api/join", { name, token: getToken() });
  setToken(r.token);
  return r;
}
export const setVote = (ideaId: number, starred: boolean) => call<{ votes: number[] }>("PUT", `/api/votes/${ideaId}`, { starred });
export const setSubmitted = (submitted: boolean) => call<{ submitted: boolean }>("PUT", "/api/submitted", { submitted });
export const addIdea = (idea: { title: string; description: string; theme: string }) =>
  call<{ idea: Idea; ideasAdded: number }>("POST", "/api/ideas", idea);

// facilitator
export async function facilitatorLogin(passcode: string) {
  const r = await call<{ token: string }>("POST", "/api/facilitator/login", { passcode });
  setFacToken(r.token);
}
export const facState = () => call<FacilitatorState>("GET", "/api/facilitator/state", undefined, true);
export const facSettings = (patch: Record<string, unknown>) => call<{ ok: true }>("PUT", "/api/facilitator/settings", patch, true);
export const facAction = (action: string, seconds?: number) => call<{ ok: true }>("POST", "/api/facilitator/action", { action, seconds }, true);
export const facAddIdea = (idea: Partial<Idea>) => call<{ idea: Idea }>("POST", "/api/facilitator/ideas", idea, true);
export const facEditIdea = (id: number, idea: Partial<Idea>) => call<{ idea: Idea }>("PUT", `/api/facilitator/ideas/${id}`, idea, true);
export const facDeleteIdea = (id: number) => call<{ ok: true }>("DELETE", `/api/facilitator/ideas/${id}`, undefined, true);
export const facMerge = (from: number, into: number) => call<{ ok: true }>("POST", "/api/facilitator/ideas/merge", { from, into }, true);
export const facImport = (format: "csv" | "json", content: string, mode: "append" | "replace") =>
  call<{ added: number; skipped: number }>("POST", "/api/facilitator/import", { format, content, mode }, true);
