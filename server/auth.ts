import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SESSION_MS = 12 * 60 * 60 * 1000;
const sha = (s: string) => createHash("sha256").update(s).digest();

/**
 * Facilitator auth with a single shared passcode. Tokens are signed (HMAC) and carry an expiry, so they
 * survive a server restart mid-session without any stored sessions. With no passcode set, the
 * facilitator view is disabled rather than open.
 */
export function createAuth(passcode: string | undefined, now: () => number = Date.now) {
  const enabled = !!passcode;
  const key = sha(`brainstorm-facilitator|${passcode ?? ""}`);
  const sign = (exp: string) => createHmac("sha256", key).update(exp).digest("base64url");

  return {
    enabled,
    login(attempt: string): string | null {
      if (!enabled || !timingSafeEqual(sha(attempt), sha(passcode!))) return null;
      const exp = String(now() + SESSION_MS);
      return `${exp}.${sign(exp)}`;
    },
    verify(token: string | undefined | null): boolean {
      if (!enabled || !token) return false;
      const [exp, sig] = token.split(".");
      if (!exp || !sig || Number(exp) < now()) return false;
      const good = Buffer.from(sign(exp));
      const given = Buffer.from(sig);
      return good.length === given.length && timingSafeEqual(good, given);
    },
  };
}

/** Allow a few wrong passcodes per client per minute so the passcode cannot be guessed quickly. */
export function createThrottle(limit = 5, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    blocked(id: string) {
      const recent = (hits.get(id) ?? []).filter((t) => now() - t < windowMs);
      hits.set(id, recent);
      return recent.length >= limit;
    },
    fail(id: string) {
      hits.set(id, [...(hits.get(id) ?? []), now()]);
    },
  };
}
