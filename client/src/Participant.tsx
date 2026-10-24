import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Board as BoardData } from "./api";
import { Board } from "./Board";
import { Countdown, remainingMs } from "./Countdown";
import { ParticipantHelp, ParticipantWelcome } from "./Help";

/** Make sure a subtitle ends with punctuation before more text follows it. */
const withStop = (s: string) => (/[.!?:]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function Participant({ sid }: { sid: string }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [nudged, setNudged] = useState(false);
  const joined = !!data?.me;

  const refresh = () =>
    api
      .fetchBoard(sid)
      .then((d) => {
        setOffset(d.serverNow - Date.now());
        setData(d);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  // Live updates. Every (re)connect refetches, so a refresh, sleep or network drop never loses state.
  useEffect(() => {
    if (!joined) return;
    return api.connectLive(sid, "participant", {
      onOpen: refresh,
      onStatus: setOnline,
      onPush: (m) => {
        if (m.type === "refresh") refresh();
        else if (m.type === "nudge") setNudged(true);
        else if (m.type === "deleted") {
          setError("The facilitator has ended this session.");
          setData(null);
        }
        else if (m.type === "ideas") setData((d) => (d ? { ...d, ideas: m.ideas } : d));
        else if (m.type === "votes") setData((d) => (d && d.me ? { ...d, me: { ...d.me, votes: m.votes } } : d));
      },
    });
  }, [joined]);

  useEffect(() => {
    if (data?.me) api.rememberJoined(sid, data.board.title);
  }, [data?.me?.name, data?.board.title]);

  // Tint the page with the facilitator's chosen background.
  useEffect(() => {
    if (data?.board.bg) document.body.style.background = data.board.bg;
    if (data?.board.title) document.title = data.board.title;
  }, [data?.board.bg, data?.board.title]);

  if (error && !data) {
    return (
      <main class="page narrow">
        <h1>This session isn't available</h1>
        <p role="alert" class="error">{error}</p>
        <p><a href="/">Go to the home page</a></p>
      </main>
    );
  }
  if (!data) return <main class="page"><p>Loading…</p></main>;
  if (!data.me) return <JoinForm sid={sid} board={data} onJoined={refresh} />;
  return <Voting sid={sid} data={data} setData={setData} refresh={refresh} online={online} offset={offset} nudged={nudged} clearNudge={() => setNudged(false)} />;
}

function JoinForm({ sid, board, onJoined }: { sid: string; board: BoardData; onJoined: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.join(sid, name);
      onJoined();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main class="page narrow">
      <h1>{board.board.title}</h1>
      {board.board.subtitle && <p class="lead">{board.board.subtitle}</p>}
      <form onSubmit={submit}>
        <label for="name">Your name</label>
        <input
          id="name" value={name} autoFocus autocomplete="name" maxLength={60}
          aria-describedby={error ? "name-error" : undefined} aria-invalid={error ? "true" : undefined}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        {error && <p id="name-error" role="alert" class="error">{error}</p>}
        <button class="primary" type="submit" disabled={busy || !name.trim()}>Join</button>
      </form>
      <ParticipantWelcome votes={board.settings.votesPerPerson} />
    </main>
  );
}

type SetData = (f: (d: BoardData | null) => BoardData | null) => void;

function Voting(props: { sid: string; data: BoardData; setData: SetData; refresh: () => void; online: boolean; offset: number; nudged: boolean; clearNudge: () => void }) {
  const { sid, data, setData, refresh, online, offset, nudged, clearNudge } = props;
  const { settings, ideas, columns, me } = data;
  const votes = new Set(me!.votes);
  const [error, setError] = useState("");
  const used = votes.size;
  const full = used >= settings.votesPerPerson;
  const voting = settings.phase === "voting";
  const { timer } = settings;
  const canSuggest = settings.ideasOpen && settings.phase === "setup" && settings.ideasPerPerson - me!.ideasAdded > 0;
  const ideasClosed = settings.ideasOpen && settings.phase !== "setup";

  // Re-render every second while a timer runs, so the "almost out of time" prompt can appear on its own.
  const [, tick] = useState(0);
  useEffect(() => {
    if (timer.state !== "running") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timer.state, timer.endsAt]);
  const left = remainingMs(timer, offset);
  const almostOut = voting && timer.state === "running" && left !== null && left <= 60_000;
  const timeUp = voting && timer.state === "ended";
  const unsubmitted = voting && !me!.submitted;
  const needsSubmit = unsubmitted && used > 0;
  const urgent = unsubmitted && (nudged || almostOut || timeUp);

  useEffect(() => {
    if (me!.submitted || !voting) clearNudge();
  }, [me!.submitted, voting]);

  // Leaving with stars that are not submitted yet? Ask first. (Stars are saved either way; this is a prompt to finish.)
  useEffect(() => {
    if (!needsSubmit) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [needsSubmit]);

  const setVotes = (next: number[]) => setData((d) => (d && d.me ? { ...d, me: { ...d.me, votes: next } } : d));

  const toggle = async (id: number) => {
    if (!voting) return;
    const next = !votes.has(id);
    const before = me!.votes;
    setError("");
    setVotes(next ? [...before, id] : before.filter((v) => v !== id)); // optimistic
    try {
      setVotes((await api.setVote(sid, id, next)).votes);
    } catch (e) {
      setVotes(before);
      setError((e as Error).message);
      refresh(); // the phase may have changed (locked, reopened); pick up the truth
    }
  };

  const submit = async (submitted: boolean) => {
    setError("");
    try {
      await api.setSubmitted(sid, submitted);
      setData((d) => (d && d.me ? { ...d, me: { ...d.me, submitted } } : d));
    } catch (e) {
      setError((e as Error).message);
      refresh();
    }
  };

  return (
    <>
      <header class="bar">
        <div class="bar-inner">
          <span class="who">{me!.name}</span>
          {timer.state !== "stopped" && <Countdown timer={timer} offset={offset} />}
          <span class={`counter${full ? " full" : ""}`} role="status" aria-live="polite">
            {used} of {settings.votesPerPerson} used
          </span>
        </div>
        {!online && <p class="offline" role="status">Reconnecting… your stars are saved.</p>}
      </header>
      <main class={`page wide${voting ? " has-bar" : ""}`}>
        <h1>{data.board.title}</h1>
        <p class="lead">
          {withStop(data.board.subtitle || "Choose the ideas you feel most strongly about")} Star up to {settings.votesPerPerson}, then press Submit. Your picks are private.
        </p>
        <ParticipantHelp votes={settings.votesPerPerson} canAdd={settings.ideasOpen && settings.phase === "setup"} />
        {settings.phase === "setup" && (
          <p class="notice">
            Waiting for the facilitator to start voting. You can read the ideas now.
            {settings.ideasOpen && <> You can also add your own idea, but <strong>only until voting starts</strong>.</>}
          </p>
        )}
        {settings.phase !== "setup" && settings.ideasOpen && (
          <p class="notice" role="note">Voting has started, so new ideas can't be added any more.</p>
        )}
        {settings.phase === "locked" && (
          <p class="notice">
            Voting is locked. {used > 0 && !me!.submitted ? `You didn't press Submit, but your ${used} ${used === 1 ? "star was" : "stars were"} saved and counted.` : "Your stars are saved."}
          </p>
        )}
        {settings.phase === "revealed" && (
          <p class="notice">
            Voting is closed and the facilitator is sharing the results. {used > 0 && !me!.submitted ? `You didn't press Submit, but your ${used} ${used === 1 ? "star was" : "stars were"} saved and counted.` : "Your stars are saved."}
          </p>
        )}
        {urgent && (
          <p class="notice urgent" role="alert">
            {nudged ? "The facilitator is waiting for you to submit. " : timeUp ? "Time is up. " : "Less than a minute left. "}
            {used === 0 ? `Star up to ${settings.votesPerPerson} ideas, then press Submit.` : "Press Submit now so your response is in."}
          </p>
        )}
        {voting && timer.state === "paused" && <p class="notice">The facilitator paused the timer.</p>}
        {voting && timer.state === "ended" && <p class="notice">Time is up. The facilitator will lock voting shortly.</p>}
        <p role="alert" class="error" hidden={!error}>{error}</p>

        {ideas.length === 0 && !canSuggest && <p class="empty">No ideas yet. They will appear here as soon as they are added.</p>}

        <Board
          columns={columns}
          ideas={ideas}
          vote={{ votes, enabled: voting, full, onToggle: toggle }}
          showEmptyGroup={canSuggest || ideasClosed}
          groupExtra={
            canSuggest ? <SuggestTile sid={sid} left={settings.ideasPerPerson - me!.ideasAdded} onAdded={refresh} />
            : ideasClosed ? <div class="add-tile closed" role="note"><strong>Adding ideas is closed</strong><span class="hint">New ideas can only be added before voting starts.</span></div>
            : undefined
          }
        />
      </main>

      {voting && (
        <div class={`submit-bar${me!.submitted ? " done" : full ? " ready" : ""}${urgent ? " urgent" : ""}`} role="region" aria-label="Submit your stars">
          <div class="submit-bar-inner">
            {me!.submitted ? (
              <>
                <span class="done-text">✓ Submitted. You can still change your stars until voting locks.</span>
                <button class="secondary" onClick={() => submit(false)}>Undo</button>
              </>
            ) : (
              <>
                <span>
                  {used === 0 ? `Star up to ${settings.votesPerPerson} ideas, then submit.`
                    : full ? "You've used all your stars. Submit when you're happy with them."
                    : `${used} of ${settings.votesPerPerson} stars used. Submit when you're done.`}
                </span>
                <button class="primary" disabled={used === 0} onClick={() => submit(true)}>Submit my stars</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The dashed "Add your own idea" tile at the end of the group column. */
function SuggestTile({ sid, left, onAdded }: { sid: string; left: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.suggestIdea(sid, { title, summary });
      setTitle(""); setSummary(""); setOpen(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <button class="add-tile" onClick={() => setOpen(true)}>
        <span class="plus" aria-hidden="true">+</span>
        <strong>Add your own idea</strong>
        <span class="hint">It joins the board for everyone to star. {left} left. You can add ideas until voting starts.</span>
      </button>
    );
  }
  return (
    <form class="add-form" onSubmit={submit} aria-label="Add your own idea">
      <label for="s-title">Title</label>
      <input id="s-title" value={title} maxLength={120} required autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      <label for="s-sum">One or two sentences</label>
      <textarea id="s-sum" value={summary} maxLength={400} rows={3} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} />
      <p role="alert" class="error" hidden={!error}>{error}</p>
      <div class="row">
        <button class="primary" type="submit" disabled={busy || !title.trim()}>Add idea</button>
        <button class="secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p class="hint">Visible to everyone, and not labeled with your name.</p>
    </form>
  );
}
