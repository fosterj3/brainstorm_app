import { createHmac } from "node:crypto";
import net from "node:net";

/**
 * What the organizer can learn about each person, kept deliberately coarse. A device type such as "Chrome on Windows"
 * and a short scrambled network code stand in for the browser string and the IP address, which are never stored.
 */

/** "Chrome on Windows", "Safari on iPhone" and so on, from the browser's User-Agent. Empty when there is none. */
export function deviceFromUserAgent(ua: string | undefined): string {
  const s = String(ua ?? "").slice(0, 400);
  if (!s.trim()) return "";
  const os = /iPhone/i.test(s) ? "iPhone"
    : /iPad/i.test(s) ? "iPad"
    : /Android/i.test(s) ? "Android"
    : /CrOS/i.test(s) ? "ChromeOS"
    : /Windows/i.test(s) ? "Windows"
    : /Macintosh|Mac OS X/i.test(s) ? "Mac"
    : /Linux|X11/i.test(s) ? "Linux"
    : "";
  // Order matters: Edge, Opera and Samsung Internet also say "Chrome", and Chrome also says "Safari".
  const browser = /EdgA?\/|Edg\//.test(s) ? "Edge"
    : /OPR\/|Opera/i.test(s) ? "Opera"
    : /SamsungBrowser/i.test(s) ? "Samsung Internet"
    : /Firefox\/|FxiOS/i.test(s) ? "Firefox"
    : /Chrome\/|CriOS/i.test(s) ? "Chrome"
    : /Safari\//i.test(s) ? "Safari"
    : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Other device";
}

/** An IPv4 address as is, or an IPv6 address cut to its first 64 bits (the part one home or office shares). */
function networkOf(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (net.isIPv6(ip)) {
    const [head, tail = ""] = ip.split("::");
    const a = head ? head.split(":") : [];
    const b = tail ? tail.split(":") : [];
    const groups = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
    return groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":");
  }
  return ip;
}

/**
 * A short code for "where this person connected from". It is a keyed hash of the network, cut to 20 bits, with a
 * different key for every poll. Two people on one network get the same code, but the code cannot be turned back into
 * an address (about 4,000 addresses share each code) and cannot be matched across polls. Roughly one pair in a million
 * matches by chance, so treat a match as a hint, not proof.
 */
export function networkCode(ip: string | undefined, salt: string): string {
  if (!ip) return "";
  return createHmac("sha256", salt).update(networkOf(ip)).digest("hex").slice(0, 5);
}

const squashName = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

const withinOneEdit = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1);
};

/**
 * Whether two names could be the same person typing themselves in twice: the same letters ignoring spaces and punctuation
 * ("Ann R." and "ann r"), one starting with the other ("Ann" and "Ann Reyes"), or a one-letter slip ("Jonathan" and
 * "Jonathon"). Very short names only match when identical, so "Al" and "Alan" are left alone.
 */
export function similarNames(a: string, b: string): boolean {
  const x = squashName(a);
  const y = squashName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3) return false;
  if (long.startsWith(short)) return true;
  return short.length >= 4 && withinOneEdit(x, y);
}
