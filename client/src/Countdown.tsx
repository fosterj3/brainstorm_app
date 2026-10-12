import { useEffect, useState } from "preact/hooks";
import type { Timer } from "./api";

/** Time left in ms, derived from the server's clock so every device agrees, whatever its own clock says. */
export function remainingMs(timer: Timer, offset: number, nowLocal = Date.now()): number | null {
  if (timer.state === "running" && timer.endsAt !== null) return Math.max(0, timer.endsAt - (nowLocal + offset));
  if (timer.state === "paused") return timer.remainingMs ?? 0;
  if (timer.state === "ended") return 0;
  return null;
}

export const format = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const MILESTONES = [300, 60, 30, 10];

/**
 * Countdown display. `offset` is serverNow - Date.now() captured when the state arrived.
 * The visible digits are hidden from screen readers; a separate polite message speaks only at milestones.
 */
export function Countdown({ timer, offset, big = false }: { timer: Timer; offset: number; big?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (timer.state !== "running") return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [timer.state, timer.endsAt]);

  const ms = remainingMs(timer, offset);
  if (ms === null) return null;
  const secs = Math.ceil(ms / 1000);
  const low = timer.state === "running" && secs <= 30;

  let spoken = "";
  if (timer.state === "paused") spoken = "Timer paused.";
  else if (timer.state === "ended" || (timer.state === "running" && secs === 0)) spoken = "Time is up.";
  else if (MILESTONES.includes(secs)) spoken = secs >= 60 ? `${secs / 60} ${secs === 60 ? "minute" : "minutes"} left.` : `${secs} seconds left.`;

  return (
    <span class={`countdown${low ? " low" : ""}${timer.state === "paused" ? " paused" : ""}${big ? " big" : ""}`}>
      <span aria-hidden="true">
        {timer.state === "ended" ? "Time's up" : format(ms)}
        {timer.state === "paused" && " ⏸"}
      </span>
      <span class="sr-only" role="status" aria-live="polite">{spoken}</span>
    </span>
  );
}
