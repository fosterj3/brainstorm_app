import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** Remember per browser which tours have been seen, so each one starts by itself only the first time. */
const seenKey = (id: string) => `brainstorm.tour.${id}`;
const wasSeen = (id: string) => {
  try { return localStorage.getItem(seenKey(id)) === "1"; } catch { return false; }
};
const markSeen = (id: string) => {
  try { localStorage.setItem(seenKey(id), "1"); } catch { /* private mode: it just starts again next time */ }
};

interface Step { title: string; body: ComponentChildren }

/** Starts open the first time, closes for good once dismissed, and can be reopened with `start`. */
export function useTour(id: string) {
  const [open, setOpen] = useState(() => !wasSeen(id));
  return {
    open,
    start: () => setOpen(true),
    close: () => { markSeen(id); setOpen(false); },
  };
}

/** Small "Take the tour" button for page headers. */
export function TourButton({ onClick, label = "Take the tour" }: { onClick: () => void; label?: string }) {
  return <button type="button" class="tour-btn" onClick={onClick}>{label}</button>;
}

/** A step-by-step walkthrough in a modal dialog. Keyboard friendly: Esc skips, Tab stays inside. */
export function Tour({ title, steps, onClose }: { title: string; steps: Step[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const last = i === steps.length - 1;
  const step = steps[i];

  // Focus the dialog on open and hand focus back to whatever had it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowRight" && !last) return setI(i + 1);
    if (e.key === "ArrowLeft" && i > 0) return setI(i - 1);
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (items.length === 0) return;
    const first = items[0], end = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); end.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first.focus(); }
  };

  return (
    <div class="tour-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabIndex={-1} ref={box} onKeyDown={onKeyDown}>
        <p class="tour-kicker">{title} · Step {i + 1} of {steps.length}</p>
        <h2 id="tour-title">{step.title}</h2>
        <div class="tour-body" aria-live="polite">{step.body}</div>
        <div class="tour-dots" aria-hidden="true">
          {steps.map((_, n) => <span key={n} class={n === i ? "on" : ""} />)}
        </div>
        <div class="tour-actions">
          <button type="button" class="tour-skip" onClick={onClose}>{last ? "Close" : "Skip tour"}</button>
          <span class="tour-nav">
            {i > 0 && <button type="button" class="secondary" onClick={() => setI(i - 1)}>Back</button>}
            <button type="button" class="primary" onClick={() => (last ? onClose() : setI(i + 1))}>{last ? "Got it" : "Next"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

export const homeTour: Step[] = [
  {
    title: "Welcome",
    body: <p>This app runs a quick, silent vote. A facilitator builds a board of ideas, shares one link, and everyone stars their favorites at the same time, so the loudest voice does not decide. This tour shows how it works.</p>,
  },
  {
    title: "If you were sent a link",
    body: <p>Just open the link you were given, or paste it (or the short session code) under <strong>Join a session</strong>. You will enter your name, star your top ideas and press Submit. Nothing to install and no account needed.</p>,
  },
  {
    title: "If you are the facilitator",
    body: <p>Use <strong>Facilitate a session</strong>: give your session a title and choose a blank board or an example to edit. You get a private facilitator link, which controls the session, and a separate participant link to share. Keep the facilitator link to yourself.</p>,
  },
  {
    title: "Coming back later",
    body: <p>Boards you create or join on this device are listed on this page. Lost a board? <strong>Restore results from a CSV</strong> rebuilds the ranking from a file you downloaded earlier. Use <strong>Take the tour</strong> any time to see this again.</p>,
  },
];

export const participantTour = (votes: number, canAdd: boolean): Step[] => [
  {
    title: "Welcome",
    body: <p>You are in. This is a silent vote: you will pick the ideas you feel most strongly about, and your choices stay private. It takes a couple of minutes.</p>,
  },
  {
    title: "Read the ideas",
    body: <p>Ideas sit in colored columns. Tap a column heading to collapse or expand it, and tap <strong>Details</strong> on a card for more. You can read while you wait for the facilitator to start voting.</p>,
  },
  {
    title: `Star up to ${votes}`,
    body: <p>When voting is open, tap the star (☆) on the ideas you want to back. The counter at the top shows how many you have used. You have {votes} in total. Tap a star again to take it back and choose a different idea.</p>,
  },
  ...(canAdd ? [{
    title: "Add your own idea",
    body: <p>Missing something? Use <strong>Add your own idea</strong> in the last column. It joins the board for everyone to star and does not show your name. You can only add ideas before voting starts.</p>,
  }] : []),
  {
    title: "Submit when you are done",
    body: <p>Press <strong>Submit my stars</strong> to tell the facilitator you are finished. You can still change your stars until voting is locked. If a timer is showing, it counts down to the lock. Your stars are saved as you go, so a refresh or dropped connection loses nothing.</p>,
  },
  {
    title: "Then wait for the results",
    body: <p>When everyone is done, the facilitator locks voting and shows the ranking to the group. Your picks are never shown to other participants. Tap <strong>Take the tour</strong> if you want to see these tips again.</p>,
  },
];

export const facilitatorTour: Step[] = [
  {
    title: "Welcome, facilitator",
    body: <p>This tour walks you through running a session from start to finish. Your page has four tabs: <strong>Build the board</strong>, <strong>Preview</strong>, <strong>Run the session</strong> and <strong>Results</strong>.</p>,
  },
  {
    title: "1. Build the board",
    body: <p>In <strong>Build the board</strong>, add colored columns, then ideas with a title, a short summary and optional details. You can also import ideas from CSV or JSON, edit or merge them, and let participants add their own.</p>,
  },
  {
    title: "2. Preview it",
    body: <p>The <strong>Preview</strong> tab shows exactly what participants will see, so you can catch typos and tidy the layout before anyone joins.</p>,
  },
  {
    title: "3. Set the rules",
    body: <p>In <strong>Run the session</strong>, choose how many stars each person gets, whether results are anonymous or named, whether participants may add ideas, and set a timer if you want one.</p>,
  },
  {
    title: "4. Share the participant link",
    body: <p>Copy the participant link from <strong>Share and participants</strong> and send it to your group. <strong>Keep your facilitator link private</strong>, because anyone who has it can control the session.</p>,
  },
  {
    title: "5. Run the vote",
    body: <p>Start voting and watch the counts: how many have joined, are online and have submitted. You never see what anyone picked. Use the timer, and nudge anyone who has not submitted.</p>,
  },
  {
    title: "6. Lock and reveal",
    body: <p>Locking stops further changes. Revealing builds the ranking, where ties share a rank. You can group results by column, present full screen, and <strong>download the CSV</strong>. Do that before you leave, because boards can disappear if the site restarts.</p>,
  },
];
