/**
 * Sliding-window limiter, used to stop one client from creating boards in bulk. Facilitator access itself
 * is a long random secret in the facilitator link (see sessions.ts), which cannot be guessed.
 */
export function createThrottle(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    blocked(id: string) {
      const recent = (hits.get(id) ?? []).filter((t) => now() - t < windowMs);
      hits.set(id, recent);
      return recent.length >= limit;
    },
    record(id: string) {
      hits.set(id, [...(hits.get(id) ?? []), now()]);
    },
  };
}
