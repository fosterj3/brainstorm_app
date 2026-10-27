/** Friendly date and time helpers for deadlines. Times are shown in the viewer's own time zone. */

/** For example "Fri, Oct 30, 5:00 PM". */
export const formatWhen = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** How long until a time, in words: "in 3 days", "in 5 hours", "in 12 minutes", "in less than a minute". */
export function untilText(ms: number, now: number): string {
  const diff = ms - now;
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "in less than a minute";
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/** How long something took, in words: "42 sec", "3 min", "3 min 20 sec", "2 h 5 min". */
export function tookText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds && minutes < 10 ? `${minutes} min ${seconds} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A time as the "YYYY-MM-DDTHH:mm" text a datetime-local box wants, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The reverse: text from a datetime-local box (local time) to epoch ms, or null if it is empty or not a date. */
export function fromLocalInput(text: string): number | null {
  if (!text) return null;
  const t = new Date(text).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Remove a leading bullet or number from a pasted line, so "1. Pizza" and "- Pizza" both become "Pizza". */
export const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").trim();

/** Turn pasted text into option titles: one per line, blanks and bullets removed, repeats dropped. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const title = stripBullet(raw).replace(/\s+/g, " ").slice(0, 120);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push(title);
  }
  return out;
}

/** Of the titles being added, the ones not already in the list (ignoring capital letters), so a paste never makes repeats. */
export function onlyNew(existing: string[], incoming: string[]): string[] {
  const have = new Set(existing.map((t) => t.trim().toLowerCase()));
  return incoming.filter((t) => !have.has(t.trim().toLowerCase()));
}
