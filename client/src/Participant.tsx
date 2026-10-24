import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Board as BoardData, Column, Results } from "./api";
import { Board } from "./Board";
import { Countdown, remainingMs } from "./Countdown";
import { participantTour, Tour, TourButton, useTour } from "./Help";
import { counterText, instruction, isReady, orderFromBallot, pointsUsed, rankValues, submitHint } from "./methods";
import { RankBallot } from "./Rank";
import { ResultsView, Summary } from "./Results";
import { formatWhen, untilText } from "./time";
import { Loading, Wordmark } from "./Site";

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
          setError("The organizer has ended this poll.");
          setData(null);
        }
        else if (m.type === "ideas") setData((d) => (d ? { ...d, ideas: m.ideas } : d));
        else if (m.type === "votes") setData((d) => (d && d.me ? { ...d, me: { ...d.me, votes: m.votes, ballot: m.ballot ?? Object.fromEntries(m.votes.map((id) => [id, 1])) } } : d));
      },
    });
  }, [joined]);

  useEffect(() => {
    if (data?.me) api.rememberJoined(sid, data.board.title);
  }, [data?.me?.name, data?.board.title]);

  // Tint the page with the organizer's chosen background.
  useEffect(() => {
    if (data?.board.bg) document.body.style.background = data.board.bg;
    if (data?.board.title) document.title = data.board.title;
  }, [data?.board.bg, data?.board.title]);

  if (error && !data) {
    return (
      <main class="page narrow">
        <h1>This poll isn't available</h1>
        <p role="alert" class="error">{error}</p>
        <p><a href="/">Go to the home page</a></p>
      </main>
    );
  }
  if (!data) return <main class="page"><Loading label="Loading the poll…" /></main>;
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
      <p class="hint">After you join, a short tour shows you how to vote. Your picks are private.</p>
    </main>
  );
}

type SetData = (f: (d: BoardData | null) => BoardData | null) => void;

function Voting(props: { sid: string; data: BoardData; setData: SetData; refresh: () => void; online: boolean; offset: number; nudged: boolean; clearNudge: () => void }) {
  const { sid, data, setData, refresh, online, offset, nudged, clearNudge } = props;
  const { settings, ideas, columns, me, limits } = data;
  const { method } = settings;
  const ballot = me!.ballot;
  const votes = new Set(me!.votes);
  const [error, setError] = useState("");
  const tour = useTour("participant");
  const ideaIds = ideas.map((i) => i.id);
  const given = Object.keys(ballot).length; // options this person has put a vote, rank, score or points on
  const dotsUsed = votes.size;
  const used = given;
  const voting = settings.phase === "voting";
  const { timer } = settings;
  const poll = settings.mode === "poll";
  const closed = poll && settings.phase !== "voting";
  const canSuggest = settings.ideasOpen && settings.phase === "setup" && settings.ideasPerPerson - me!.ideasAdded > 0;
  const ideasClosed = settings.ideasOpen && settings.phase !== "setup";

  // Rank polls keep the order on screen while it is being dragged, and save it when the move is finished.
  const [order, setOrder] = useState(() => orderFromBallot(ballot, ideaIds, limits.rankSlots));
  const ballotKey = JSON.stringify(ballot);
  useEffect(() => {
    setOrder(orderFromBallot(ballot, ideaIds, limits.rankSlots));
  }, [ballotKey, ideaIds.join(","), limits.rankSlots]);

  const full =
    method === "dots" ? dotsUsed >= settings.votesPerPerson
    : method === "points" ? pointsUsed(ballot) === limits.pointsTotal
    : method === "rank" ? limits.rankSlots > 0 && order.length >= limits.rankSlots
    : false;
  const ready = isReady(method, ballot, limits, dotsUsed, order.length);

  // Open polls: keep the "closes in ..." wording fresh, and look again the moment the deadline passes so a screen that
  // is left open switches to "closed" by itself. The server decides; this just asks it at the right time.
  useEffect(() => {
    if (!poll || !voting || settings.deadline === null) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    let timeout: number;
    const wait = () => {
      const ms = settings.deadline! - (Date.now() + offset);
      timeout = window.setTimeout(() => (settings.deadline! - (Date.now() + offset) <= 0 ? refresh() : wait()), Math.min(Math.max(ms, 0) + 800, 6 * 3600_000));
    };
    wait();
    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
  }, [poll, voting, settings.deadline, offset]);

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

  // Leaving with votes that are not submitted yet? Ask first. (Votes are saved either way; this is a prompt to finish.)
  useEffect(() => {
    if (!needsSubmit) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [needsSubmit]);

  const setVotes = (next: number[]) => setData((d) => (d && d.me ? { ...d, me: { ...d.me, votes: next, ballot: Object.fromEntries(next.map((id) => [id, 1])) } } : d));

  // Dot polls: one option at a time.
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

  // Rank, score and points polls: the whole ballot is saved each time. Only the newest answer is applied,
  // so quick taps cannot be overwritten by an older reply arriving late.
  const newest = useRef(0);
  const saveBallot = async (values: Record<number, number>) => {
    if (!voting) return;
    const mine = ++newest.current;
    setError("");
    setData((d) => (d && d.me ? { ...d, me: { ...d.me, ballot: values, votes: Object.keys(values).map(Number) } } : d)); // optimistic
    try {
      const r = await api.setBallot(sid, values);
      if (mine === newest.current) setData((d) => (d && d.me ? { ...d, me: { ...d.me, ballot: r.ballot, votes: r.votes, submitted: r.submitted } } : d));
    } catch (e) {
      if (mine === newest.current) {
        setError((e as Error).message);
        refresh();
      }
    }
  };
  const setValue = (id: number, value: number | null) => {
    const next = { ...ballot };
    if (value === null) delete next[id];
    else next[id] = value;
    return saveBallot(next);
  };

  const submit = async (submitted: boolean) => {
    setError("");
    try {
      if (submitted && method === "rank") {
        // A ranking that was only ever shown in its listed order has not been saved yet.
        const values = rankValues(order);
        const same = Object.keys(values).length === given && Object.entries(values).every(([k, v]) => ballot[Number(k)] === v);
        if (!same) await saveBallot(values);
      }
      await api.setSubmitted(sid, submitted);
      setData((d) => (d && d.me ? { ...d, me: { ...d.me, submitted } } : d));
    } catch (e) {
      setError((e as Error).message);
      refresh();
    }
  };

  const savedLine = used > 0 && !me!.submitted
    ? method === "dots"
      ? `You didn't press Submit, but your ${used} ${used === 1 ? "vote was" : "votes were"} saved and counted.`
      : "You didn't press Submit, but your answers were saved and counted."
    : method === "dots" ? "Your votes are saved." : "Your answers are saved.";
  const ctx = { votesPerPerson: settings.votesPerPerson, limits, optionCount: ideas.length };
  const adding = canSuggest ? <SuggestTile sid={sid} left={settings.ideasPerPerson - me!.ideasAdded} onAdded={refresh} />
    : ideasClosed ? <div class="add-tile closed" role="note"><strong>Adding options is closed</strong><span class="hint">New options can only be added before voting starts.</span></div>
    : undefined;

  return (
    <>
      {tour.open && <Tour title="Voting tour" steps={participantTour(method, settings.votesPerPerson, settings.ideasOpen && settings.phase === "setup", limits, ideas.length)} onClose={tour.close} />}
      <header class="bar">
        <div class="bar-inner">
          <Wordmark />
          <span class="who">{me!.name}</span>
          <TourButton onClick={tour.start} label="Help" />
          {timer.state !== "stopped" && <Countdown timer={timer} offset={offset} />}
          <span class={`counter${full ? " full" : ""}`} role="status" aria-live="polite">
            {counterText(method, { ballot, limits, votesPerPerson: settings.votesPerPerson, dotsUsed, rankLength: order.length, optionCount: ideas.length })}
          </span>
        </div>
        {!online && <p class="offline" role="status">Reconnecting… your {method === "dots" ? "votes are" : "answers are"} saved.</p>}
      </header>
      <main class={`page wide${voting ? " has-bar" : ""}`}>
        <h1>{data.board.title}</h1>
        <p class="lead">
          {withStop(data.board.subtitle || (method === "dots" ? "Choose the options you feel most strongly about" : "Tell us what matters most"))} {closed ? "Thank you to everyone who took part." : `${instruction(method, ctx)} Your picks are private.`}
        </p>
        {settings.phase === "setup" && (
          <p class="notice">
            Waiting for the organizer to start voting. You can read the options now.
            {settings.ideasOpen && <> You can also add your own option, but <strong>only until voting starts</strong>.</>}
          </p>
        )}
        {settings.phase !== "setup" && settings.ideasOpen && (
          <p class="notice" role="note">Voting has started, so new options can't be added any more.</p>
        )}
        {poll && voting && (
          <p class="notice" role="note">
            {settings.deadline !== null
              ? <>This poll closes on <strong>{formatWhen(settings.deadline)}</strong> ({untilText(settings.deadline, Date.now() + offset)}). You can change your answers until then.</>
              : <>You can change your answers until the organizer closes the poll.</>}
          </p>
        )}
        {closed && (
          <p class="notice" role="status">
            This poll has closed.{" "}{savedLine}{!settings.shareResults && " The organizer will share the results."}
          </p>
        )}
        {closed && settings.shareResults && <SharedResults sid={sid} columns={columns} />}
        {!poll && settings.phase === "locked" && <p class="notice">Voting is locked. {savedLine}</p>}
        {!poll && settings.phase === "revealed" && <p class="notice">Voting is closed and the organizer is sharing the results. {savedLine}</p>}
        {urgent && (
          <p class="notice urgent" role="alert">
            {nudged ? "The organizer is waiting for you to submit. " : timeUp ? "Time is up. " : "Less than a minute left. "}
            {used === 0 ? instruction(method, ctx) : "Press Submit now so your response is in."}
          </p>
        )}
        {voting && timer.state === "paused" && <p class="notice">The organizer paused the timer.</p>}
        {voting && timer.state === "ended" && <p class="notice">Time is up. The organizer will lock voting shortly.</p>}
        <p role="alert" class="error" hidden={!error}>{error}</p>

        {ideas.length === 0 && !canSuggest && <p class="empty">No options yet. They will appear here as soon as they are added.</p>}

        {method === "rank" ? (
          <RankBallot
            ideas={ideas} columns={columns} order={order} slots={limits.rankSlots} enabled={voting}
            onChange={setOrder} onCommit={(next) => saveBallot(rankValues(next))}
            extra={adding && <div class="rank-extra">{adding}</div>}
          />
        ) : (
          <Board
            columns={columns}
            ideas={ideas}
            vote={{ method, votes, ballot, limits, enabled: voting, full: method === "dots" && full, onToggle: toggle, onSetValue: setValue }}
            showEmptyGroup={canSuggest || ideasClosed}
            groupExtra={adding}
          />
        )}
      </main>

      {voting && (
        <div class={`submit-bar${me!.submitted ? " done" : full || ready ? " ready" : ""}${urgent ? " urgent" : ""}`} role="region" aria-label="Submit your votes">
          <div class="submit-bar-inner">
            {me!.submitted ? (
              <>
                <span class="done-text">✓ Submitted. You can still change your {method === "dots" ? "votes" : "answers"} until voting locks.</span>
                <button class="secondary" onClick={() => submit(false)}>Undo</button>
              </>
            ) : (
              <>
                <span>{submitHint(method, { ...ctx, dotsUsed, ballot, rankLength: order.length, ready })}</span>
                <button class="primary" disabled={!ready} onClick={() => submit(true)}>Submit my votes</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
/** Results the organizer chose to share after an open poll closed. Always anonymous. */
function SharedResults({ sid, columns }: { sid: string; columns: Column[] }) {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.fetchSharedResults(sid).then(setResults).catch((e: Error) => setError(e.message));
  }, [sid]);
  return (
    <section class="panel" aria-labelledby="h-shared">
      <h2 id="h-shared">Results</h2>
      {error && <p class="error" role="alert">{error}</p>}
      {!results && !error && <Loading label="Loading results…" />}
      {results && (
        <>
          <Summary results={results} />
          <ResultsView results={results} columns={columns} view="ranked" />
        </>
      )}
    </section>
  );
}

/** The dashed "Add your own option" tile in the ungrouped section. */
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
        <strong>Add your own option</strong>
        <span class="hint">It joins the poll for everyone to vote on. {left} left. You can add options until voting starts.</span>
      </button>
    );
  }
  return (
    <form class="add-form" onSubmit={submit} aria-label="Add your own option">
      <label for="s-title">Title</label>
      <input id="s-title" value={title} maxLength={120} required autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      <label for="s-sum">One or two sentences</label>
      <textarea id="s-sum" value={summary} maxLength={400} rows={3} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} />
      <p role="alert" class="error" hidden={!error}>{error}</p>
      <div class="row">
        <button class="primary" type="submit" disabled={busy || !title.trim()}>Add option</button>
        <button class="secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p class="hint">Visible to everyone, and not labeled with your name.</p>
    </form>
  );
}
