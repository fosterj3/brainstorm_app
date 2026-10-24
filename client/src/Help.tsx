import { useState } from "preact/hooks";

/** Remember per browser whether a guide has been dismissed, so it opens itself only the first time. */
const seenKey = (id: string) => `brainstorm.help.${id}`;
const wasSeen = (id: string) => {
  try { return localStorage.getItem(seenKey(id)) === "1"; } catch { return false; }
};
const markSeen = (id: string) => {
  try { localStorage.setItem(seenKey(id), "1"); } catch { /* private mode: it just opens again next time */ }
};

/** A collapsible guide. Open on first visit, closed afterwards, always reachable from its summary line. */
function Guide({ id, title, children }: { id: string; title: string; children: preact.ComponentChildren }) {
  const [open, setOpen] = useState(() => !wasSeen(id));
  return (
    <details class="guide" open={open} onToggle={(e) => {
      const isOpen = (e.currentTarget as HTMLDetailsElement).open;
      setOpen(isOpen);
      if (!isOpen) markSeen(id);
    }}>
      <summary>{title}</summary>
      <div class="guide-body">{children}</div>
    </details>
  );
}

export function ParticipantSteps({ votes }: { votes?: number }) {
  const n = votes ? `up to ${votes}` : "a limited number of";
  return (
    <ol class="steps">
      <li><strong>Read the ideas.</strong> They are grouped in colored columns. Tap a column heading to collapse it, and "Details" on a card to read more.</li>
      <li><strong>Star your top picks.</strong> Once the facilitator starts voting, tap the star (☆) on {n} ideas. The counter at the top shows how many you have used. Tap a star again to take it back and choose another.</li>
      <li><strong>Press "Submit my stars"</strong> when you are happy. This tells the facilitator you are done. You can still change your stars until voting is locked.</li>
      <li><strong>Wait for the results.</strong> The facilitator locks voting and shows the ranking to the group.</li>
    </ol>
  );
}

/** Shown to participants on the join screen, before they have entered a name. */
export function ParticipantWelcome({ votes }: { votes?: number }) {
  return (
    <section class="guide-card" aria-labelledby="h-pwelcome">
      <h2 id="h-pwelcome">How this works</h2>
      <p class="hint">A quick, silent vote. It takes a couple of minutes.</p>
      <ParticipantSteps votes={votes} />
      <ul class="tips">
        <li><strong>Your picks are private.</strong> Nobody sees what you starred, and there are no running totals.</li>
        <li><strong>Nothing is lost if you refresh</strong> or your connection drops. Your stars are saved as you go.</li>
        <li>Your name is only used so the facilitator can see how many people have joined.</li>
      </ul>
    </section>
  );
}

/** Collapsible reminder while voting. Opens itself the first time someone sees it. */
export function ParticipantHelp({ votes, canAdd }: { votes: number; canAdd: boolean }) {
  return (
    <Guide id="participant" title="How do I vote?">
      <ParticipantSteps votes={votes} />
      <ul class="tips">
        <li>Your picks are private and are saved as you go.</li>
        {canAdd && <li>Missing something? Use <strong>Add your own idea</strong> in the last column. It only works before voting starts, and it will not show your name.</li>}
        <li>If a timer is showing, it counts down to when voting locks. Stars you have already chosen still count if time runs out, but press Submit so the facilitator knows you are done.</li>
      </ul>
    </Guide>
  );
}

export function FacilitatorHelp() {
  return (
    <Guide id="facilitator" title="Facilitator guide: how to run a session">
      <ol class="steps">
        <li>
          <strong>Build the board</strong> (<em>Build the board</em> tab). Add columns, then ideas with a title, a short summary and optional details. You can also import ideas from CSV or JSON, or let participants add their own.
        </li>
        <li>
          <strong>Check it</strong> (<em>Preview</em> tab) to see exactly what participants will see.
        </li>
        <li>
          <strong>Choose your settings</strong> (<em>Run the session</em> tab). Set how many stars each person gets, whether results are anonymous or named, whether participants can add ideas, and the timer.
        </li>
        <li>
          <strong>Share the participant link.</strong> Copy it from <em>Share and participants</em> and send it to your group. Keep your own facilitator link private, because anyone with it can control the session.
        </li>
        <li>
          <strong>Start voting.</strong> Participants join with a name. You see only how many have joined, are online and have submitted, never what anyone picked. Use the timer if you want one, and send a reminder to anyone who has not submitted.
        </li>
        <li>
          <strong>Lock voting, then reveal.</strong> Locking stops any more changes. Revealing builds the ranking: ties share a rank, and you can switch to a by-column view, present full screen, or download a CSV.
        </li>
      </ol>
      <ul class="tips">
        <li>Boards are removed after 90 days without use. On the free hosting plan they can also disappear if the site restarts, so <strong>download the results CSV</strong> once you reveal. The home page can rebuild a board from it.</li>
        <li>Only the person with the facilitator link can see results. Participants never receive them.</li>
        <li>Lost the facilitator link? It lives in the address bar after the <code>#</code>, and this browser remembers it under "Your boards" on the home page.</li>
      </ul>
    </Guide>
  );
}

/** Home page overview for both audiences. */
export function HowItWorks() {
  return (
    <section class="how" aria-labelledby="h-how">
      <h2 id="h-how">How it works</h2>
      <div class="how-grid">
        <div class="panel">
          <h3>Taking part?</h3>
          <p class="hint">Use the link the facilitator sent you, or paste it under "Join a session".</p>
          <ParticipantSteps />
        </div>
        <div class="panel">
          <h3>Running a session?</h3>
          <ol class="steps">
            <li>Create a board and add your columns and ideas.</li>
            <li>Send the participant link to your group.</li>
            <li>Start voting, optionally with a timer, and watch how many have submitted.</li>
            <li>Lock voting and reveal the ranked results.</li>
          </ol>
          <p class="hint">A fuller guide appears on your facilitator page.</p>
        </div>
      </div>
    </section>
  );
}
