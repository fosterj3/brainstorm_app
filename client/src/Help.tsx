import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Limits, Method, Mode } from "./api";

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
    title: "Welcome to Ority",
    body: <p>Ority helps a group agree on what matters most. Someone creates a poll, shares one link, and everyone votes privately, so the loudest voice does not decide. This tour shows how it works.</p>,
  },
  {
    title: "If you were sent a link",
    body: <p>Just open the link you were given, or paste it (or the short poll code) under <strong>Join a poll</strong>. You will enter your name, vote for your top options and press Submit. Nothing to install and no account needed.</p>,
  },
  {
    title: "If you are the organizer",
    body: <p>Use <strong>Create a poll</strong>: give it a title and choose a blank poll or an example to edit. You get a private organizer link, which controls the poll, and a separate link to share with participants. Keep the organizer link to yourself.</p>,
  },
  {
    title: "Coming back later",
    body: <p>Polls you create or join on this device are listed on this page. Lost a poll? <strong>Restore results from a CSV</strong> rebuilds the ranking from a file you downloaded earlier. Use <strong>Take the tour</strong> any time to see this again.</p>,
  },
];

/** The step that explains how to vote depends on the poll's voting method. */
const howToVote = (method: Method, votes: number, limits: Limits, optionCount: number): Step => {
  switch (method) {
    case "rank":
      return limits.rankSlots < optionCount
        ? {
            title: `Choose your top ${limits.rankSlots}`,
            body: <p>Add up to {limits.rankSlots} options from the list, then put them in order with your favorite first. Drag by the handle, or use the arrow buttons. Your order is saved as you go.</p>,
          }
        : {
            title: "Put the options in order",
            body: <p>Drag each option by its handle, or use the arrow buttons, until your favorite is first and your least favorite is last. Your order is saved as you go.</p>,
          };
    case "score":
      return {
        title: "Rate each option from 1 to 5",
        body: <p>Tap a number on each card: 5 means you feel strongly in favor and 1 means you do not. You can skip any option you have no view on, and tap your rating again to clear it.</p>,
      };
    case "points":
      return {
        title: `Split ${limits.pointsTotal} points`,
        body: <p>You have {limits.pointsTotal} points to give out. Put more on the options that matter most to you and none on the rest. The bar at the bottom shows how many are left, and you can submit once you have used all {limits.pointsTotal}.</p>,
      };
    default:
      return {
        title: `Vote for up to ${votes}`,
        body: <p>When voting is open, tap the star (☆) on the options you want to back. The counter at the top shows how many votes you have used. You have {votes} in total. Tap a star again to take a vote back and choose a different option.</p>,
      };
  }
};

export const participantTour = (method: Method, votes: number, canAdd: boolean, limits: Limits, optionCount: number): Step[] => [
  {
    title: "Welcome",
    body: <p>You are in. This is a private vote: you will share what matters most to you, and nobody sees your choices. It takes a couple of minutes.</p>,
  },
  {
    title: "Read the options",
    body: <p>Options may be sorted into colored groups. Tap a group heading to collapse or expand it, and tap <strong>Details</strong> on a card for more. You can read while you wait for the organizer to start voting.</p>,
  },
  howToVote(method, votes, limits, optionCount),
  ...(canAdd ? [{
    title: "Add your own option",
    body: <p>Missing something? Use <strong>Add your own option</strong>. It joins the poll for everyone to vote on and does not show your name. You can only add options before voting starts.</p>,
  }] : []),
  {
    title: "Submit when you are done",
    body: <p>Press <strong>Submit my votes</strong> to tell the organizer you are finished. You can still change your {method === "dots" ? "votes" : "answers"} until voting is locked. If a timer is showing, it counts down to the lock. Your {method === "dots" ? "votes are" : "answers are"} saved as you go, so a refresh or dropped connection loses nothing.</p>,
  },
  {
    title: "Then wait for the results",
    body: <p>When everyone is done, the organizer locks voting and shows the ranking to the group. Your picks are never shown to other participants. Tap <strong>Help</strong> if you want to see these tips again.</p>,
  },
];
export const facilitatorTour = (mode: Mode): Step[] => [
  {
    title: "Welcome to Ority, organizer",
    body: <p>This tour walks you through running a poll from start to finish. Your page has four tabs: <strong>Run the poll</strong>, <strong>Build the poll</strong>, <strong>Preview</strong> and <strong>Results</strong>.</p>,
  },
  {
    title: "1. Build the poll",
    body: <p>In <strong>Build the poll</strong>, add the options people will vote on, each with a title and an optional short description. Groups are optional: use them only if you want to sort options under headings. You can also import options from CSV or JSON, and let participants add their own.</p>,
  },
  {
    title: "2. Preview it",
    body: <p>The <strong>Preview</strong> tab shows exactly what participants will see, so you can catch typos and tidy the layout before anyone joins.</p>,
  },
  {
    title: "3. Set the rules",
    body: <p>In <strong>Run the poll</strong>, choose how people vote (dot voting, rank order, score, or the $100 method), whether results are anonymous or named, whether participants may add options, and set a timer if you want one. Each method has a one-line explanation, and you can change it until voting starts.</p>,
  },
  {
    title: "4. Share the participant link",
    body: <p>Copy the participant link from <strong>Share and participants</strong> and send it to your group. <strong>Keep your organizer link private</strong>, because anyone who has it can control the poll.</p>,
  },
  {
    title: "5. Run the vote",
    body: mode === "poll"
      ? <p>Your poll is already open, so just share the link. Watch how many people have joined and submitted. You never see what anyone picked. Change the closing time any time, or press <strong>Close poll now</strong> when you are ready.</p>
      : <p>Start voting and watch the counts: how many have joined, are online and have submitted. You never see what anyone picked. Use the timer, and nudge anyone who has not submitted.</p>,
  },
  {
    title: mode === "poll" ? "6. The poll closes" : "6. Lock and reveal",
    body: mode === "poll"
      ? <p>At the closing time the poll closes by itself and the results appear for you. Ties share a rank, and you can present full screen or <strong>download the CSV</strong>. Do that soon after, because polls can disappear if the site restarts. You can also reopen a closed poll.</p>
      : <p>Locking stops further changes. Revealing builds the ranking, where ties share a rank. You can group results, present full screen, and <strong>download the CSV</strong>. Do that before you leave, because polls can disappear if the site restarts.</p>,
  },
];