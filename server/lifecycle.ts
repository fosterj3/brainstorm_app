import type { FastifyInstance } from "fastify";
import type { DB } from "./db";
import type { Snapshots } from "./persist";

/**
 * Starting up and shutting down safely.
 *
 * Startup: asking the bucket for the saved copy can fail for reasons that pass (a network blip). Starting with an
 * empty database in that case would be dangerous, because the first new copy would then replace the good one with
 * an empty one. So it tries a few times, and if it still cannot reach the bucket it stops with a clear message
 * instead. Hosting restarts it, and the saved copy stays untouched.
 */
export async function withRetries<T>(what: string, attempt: () => Promise<T>, opts: { tries?: number; waitMs?: number; log?: (m: string) => void } = {}): Promise<T> {
  const tries = opts.tries ?? 5;
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await attempt();
    } catch (e) {
      last = e;
      opts.log?.(`${what} failed (try ${i} of ${tries}): ${e instanceof Error ? e.message : e}`);
      if (i < tries) await new Promise((r) => setTimeout(r, (opts.waitMs ?? 2000) * i));
    }
  }
  throw last;
}

/**
 * What to do when the host tells the server to stop (a deploy, or going to sleep): save a last copy first, so that
 * recent votes are kept, then close down. A stuck connection never blocks that final save.
 */
export function makeShutdown(opts: {
  app: FastifyInstance;
  db: DB;
  snapshots: Snapshots | null;
  log: (m: string) => void;
  /** Called last. In the real server this ends the process. */
  exit: (code: number) => void;
  closeWaitMs?: number;
}) {
  let started = false;
  return async function shutdown(reason: string) {
    if (started) return;
    started = true;
    opts.log(`${reason}: saving and shutting down.`);
    try {
      await opts.snapshots?.flush(); // first, while everything is still running
    } catch (e) {
      opts.log(`The last copy could not be saved: ${e instanceof Error ? e.message : e}`);
    }
    opts.snapshots?.stop();
    // Open connections can hold up a normal close, so do not wait for them for long.
    await Promise.race([opts.app.close().catch(() => {}), new Promise((r) => setTimeout(r, opts.closeWaitMs ?? 3000))]);
    try {
      opts.db.close();
    } catch {
      /* already closed */
    }
    opts.exit(0);
  };
}
