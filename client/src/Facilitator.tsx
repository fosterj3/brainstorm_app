import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { FacilitatorState, Settings } from "./api";
import { Board } from "./Board";
import { BoardEditor, type Run } from "./BoardEditor";
import { Countdown } from "./Countdown";
import { facilitatorTour, Tour, TourButton, useTour } from "./Help";
import { METHODS } from "./methods";
import { Loading, Wordmark } from "./Site";
import { Presentation, ResultsPanel } from "./Results";
import { formatWhen, fromLocalInput, toLocalInput, tookText, untilText } from "./time";

const PRESETS = [1, 2, 3, 5, 10, 15, 20, 30];
const PHASE_LABEL = { setup: "Setting up", voting: "Voting open", locked: "Voting locked", revealed: "Results showing" } as const;
type Tab = "run" | "build" | "preview" | "results";

/** The status chip text. Open polls are simply open or closed. */
const phaseLabel = (s: Settings) =>
  s.mode === "poll" ? (s.phase === "voting" ? "Open" : "Closed") : PHASE_LABEL[s.phase];

/** The organizer's secret arrives in the link's #fragment (never sent to the server); keep it on this device. */
function adoptKeyFromLink(sid: string) {
  const key = location.hash.replace(/^#/, "");
  if (key) {
    api.setAdminKey(sid, key);
    history.replaceState(null, "", location.pathname);
  }
}

export function Facilitator({ sid }: { sid: string }) {
  adoptKeyFromLink(sid);
  const [hasKey, setHasKey] = useState(!!api.getAdminKey(sid));
  if (!hasKey) {
    return (
      <main class="page narrow">
        <h1>Organizer link needed</h1>
        <p>This device does not have organizer access to this poll. Open the private organizer link you were given when you created it.</p>
        <p><a href="/">Go to the home page</a></p>
      </main>
    );
  }
  return <Dashboard sid={sid} onLostAccess={() => { api.forgetAdminKey(sid); setHasKey(false); }} />;
}

function Dashboard({ sid, onLostAccess }: { sid: string; onLostAccess: () => void }) {
  const [state, setState] = useState<FacilitatorState | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("brainstorm.openResults") === sid ? "results" : "run"));
  useEffect(() => { sessionStorage.removeItem("brainstorm.openResults"); }, []);
  const [presenting, setPresenting] = useState(false);
  const [welcome, setWelcome] = useState(() => api.takeJustCreated(sid)); // the one-time "your poll is ready" step
  const tour = useTour("facilitator");

  const refresh = () =>
    api
      .adminState(sid)
      .then((s) => {
        setOffset(s.serverNow - Date.now());
        setState(s);
        api.rememberBoard(sid, s.board.title);
      })
      .catch((e: api.ApiError) => (e.code === "unauthorized" ? onLostAccess() : setError(e.message)));

  useEffect(() => {
    refresh();
    return api.connectLive(sid, "facilitator", {
      onOpen: refresh,
      onStatus: setOnline,
      onPush: (m) => {
        if (m.type === "refresh") refresh();
        if (m.type === "counts") setState((s) => (s ? { ...s, counts: { joined: m.joined, connected: m.connected, submitted: m.submitted, pending: m.pending } } : s));
      },
    });
  }, []);

  useEffect(() => {
    if (state) document.title = `${state.board.title} (organizer)`;
  }, [state?.board.title]);

  /** Run an organizer action, surfacing any error; the server pushes the new state back to us. */
  const run: Run = async (fn) => {
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      const err = e as api.ApiError;
      if (err.code === "unauthorized") onLostAccess();
      else setError(err.message);
    }
  };

  if (!state) return <main class="page">{error ? <p role="alert" class="error">{error}</p> : <Loading label="Loading your poll…" />}</main>;
  const { settings, counts } = state;
  const { phase, timer } = settings;

  const tabs: [Tab, string][] = [["run", "Run the poll"], ["build", "Build the poll"], ["preview", "Preview"], ["results", "Results"]];

  return (
    <>
      {tour.open && <Tour title="Organizer tour" steps={facilitatorTour(settings.mode)} onClose={tour.close} />}
      <header class="bar">
        <div class="bar-inner">
          <Wordmark />
          <strong class="bar-title">{state.board.title}</strong>
          <span class="phase" data-phase={phase}>{phaseLabel(settings)}</span>
          {settings.mode === "poll" && phase === "voting" && settings.deadline !== null && <span class="hint">Closes {formatWhen(settings.deadline)}</span>}
          {timer.state !== "stopped" && <Countdown timer={timer} offset={offset} />}
          {counts.joined > 0 && <span class="hint">{counts.submitted} of {counts.joined} submitted</span>}
          <TourButton onClick={tour.start} />
          <a href="/" class="hint">Your polls</a>
        </div>
        {!online && <p class="offline" role="status">Reconnecting…</p>}
      </header>
      <main class="page wide">
        <div class="tabs" role="tablist" aria-label="Organizer sections">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1}
              class={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}
              onKeyDown={(e) => {
                const i = tabs.findIndex(([t]) => t === tab);
                const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
                if (next === null) return;
                const t = tabs[(next + tabs.length) % tabs.length][0];
                setTab(t);
                document.getElementById(`tab-${t}`)?.focus();
              }}>
              {label}
            </button>
          ))}
        </div>
        <p role="alert" class="error" hidden={!error}>{error}</p>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "run" && (
            <>
              {welcome && <ReadyPanel sid={sid} title={state.board.title} mode={settings.mode} onDone={() => setWelcome(false)} />}
              <SharePanel sid={sid} counts={counts} />
              {settings.mode === "poll"
                ? <PollControls sid={sid} state={state} run={run} onPresent={() => setPresenting(true)} onClosed={() => setTab("results")} />
                : <Controls sid={sid} state={state} run={run} onRevealed={() => setTab("results")} onPresent={() => setPresenting(true)} />}
              <ResponsesPanel sid={sid} state={state} run={run} />
              <SettingsPanel sid={sid} state={state} run={run} />
              <DeletePanel sid={sid} title={state.board.title} run={run} />
            </>
          )}
          {tab === "build" && (
            <>
              {phase !== "setup" && (
                <p class="notice warn" role="note">
                  {settings.mode === "poll"
                    ? "This poll is open. You can still edit it, but changing or deleting options now affects the votes already cast."
                    : "Voting has started, so participants can no longer add their own options. You can still edit the poll yourself, but changing or deleting options now affects the votes already cast."}
                </p>
              )}
              <BoardEditor sid={sid} state={state} run={run} />
            </>
          )}
          {tab === "preview" && <Preview state={state} />}
          {tab === "results" && (
            <ResultsPanel sid={sid} title={state.board.title} columns={state.columns} revealed={settings.phase === "revealed"} mode={settings.mode} onPresent={() => setPresenting(true)} run={run} />
          )}
        </div>
      </main>
      {presenting && settings.phase === "revealed" && (
        <Presentation sid={sid} title={state.board.title} subtitle={state.board.subtitle} columns={state.columns} onClose={() => setPresenting(false)} />
      )}
    </>
  );
}

function Preview({ state }: { state: FacilitatorState }) {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = state.board.bg;
    return () => { document.body.style.background = prev; };
  }, [state.board.bg]);
  return (
    <section aria-label="Poll preview">
      <p class="hint">This is what participants see, without the voting buttons.</p>
      <h1>{state.board.title}</h1>
      {state.board.subtitle && <p class="lead">{state.board.subtitle}</p>}
      <Board columns={state.columns} ideas={state.ideas} showEmptyGroup={state.settings.ideasOpen} />
    </section>
  );
}

function CopyField({ id, label, value, note }: { id: string; label: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  };
  return (
    <div class="share">
      <label for={id}>{label}</label>
      <div class="row">
        <input id={id} readOnly value={value} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <button class="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {note && <p class="hint">{note}</p>}
    </div>
  );
}

/** Shown once, right after a poll is created: the link to send people, and a plain warning about the organizer link. */
function ReadyPanel({ sid, title, mode, onDone }: { sid: string; title: string; mode: Settings["mode"]; onDone: () => void }) {
  const [copied, setCopied] = useState<"" | "share" | "admin">("");
  const share = `${location.origin}/s/${sid}`;
  const admin = `${location.origin}/f/${sid}#${api.getAdminKey(sid)}`;
  const copy = async (what: "share" | "admin", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2500);
    } catch {
      /* clipboard blocked: the links are still shown on the page below */
    }
  };
  // Opens the person's own email app with the link filled in. Nothing is sent from Ority.
  const mail = `mailto:?subject=${encodeURIComponent(`Organizer link for my poll: ${title}`)}&body=${encodeURIComponent(
    `This is the private link to run my poll "${title}". Keep it safe; anyone with it can run the poll.\n\n${admin}`,
  )}`;
  return (
    <section class="panel ready-panel" aria-labelledby="h-ready">
      <h2 id="h-ready">Your poll is ready</h2>
      <p>
        {mode === "poll"
          ? "People can vote as soon as you send them the link. Send it by email or chat."
          : "Send people this link. When everyone has joined, start the voting from the controls below."}
      </p>
      <button class="primary big" onClick={() => copy("share", share)}>{copied === "share" ? "Copied! Now paste it into an email or chat" : "Copy participant link"}</button>
      <p class="notice warn save-warning" role="note">
        <strong>Save your organizer link. It's the only way back into this page.</strong> If you lose it, you can't get into this poll again to see the results.
        Bookmark it, or send it to yourself.
      </p>
      <div class="actions">
        <button class="secondary" onClick={() => copy("admin", admin)}>{copied === "admin" ? "Copied" : "Copy organizer link"}</button>
        <a class="button-link secondary" href={mail}>Email it to myself</a>
        <button class="secondary" onClick={onDone}>Got it</button>
      </div>
    </section>
  );
}

function SharePanel({ sid, counts }: { sid: string; counts: FacilitatorState["counts"] }) {
  const key = api.getAdminKey(sid);
  return (
    <section class="panel" aria-labelledby="h-share">
      <h2 id="h-share">Share and participants</h2>
      <CopyField id="share-link" label="Link for participants" value={`${location.origin}/s/${sid}`} note={`Or give them the code ${sid} on the home page.`} />
      <CopyField
        id="admin-link" label="Your private organizer link"
        value={`${location.origin}/f/${sid}#${key}`}
        note="Keep this to yourself and bookmark it. Anyone with it can run this poll, and it is the only way back in from another device."
      />
      <p class="stats">
        <span><strong>{counts.joined}</strong> joined</span>
        <span><strong>{counts.connected}</strong> online now</span>
        <span><strong>{counts.submitted}</strong> of {counts.joined} submitted</span>
      </p>
      <p class="hint">You see only how many people have submitted, never what anyone picked.</p>
    </section>
  );
}

/** Open polls: no start button, because voting is open from the start. Change the closing time, close early, or reopen. */
function PollControls({ sid, state, run, onPresent, onClosed }: { sid: string; state: FacilitatorState; run: Run; onPresent: () => void; onClosed: () => void }) {
  const { settings, counts } = state;
  const { deadline } = settings;
  const open = settings.phase === "voting";
  const [when, setWhen] = useState(deadline ? toLocalInput(deadline) : "");
  const [reminded, setReminded] = useState("");
  const [now, setNow] = useState(Date.now());
  // Show the current closing time while open. When closed, only offer it again if it is still in the future.
  useEffect(() => setWhen(deadline && (open || deadline > Date.now()) ? toLocalInput(deadline) : ""), [deadline, open]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const pending = counts.pending;
  const picked = fromLocalInput(when);
  const closeNow = () => {
    const note = pending.length
      ? `${pending.length} ${pending.length === 1 ? "person has" : "people have"} not submitted yet: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? `, and ${pending.length - 8} more` : ""}.\n\nTheir votes so far still count. `
      : "";
    return confirm(`${note}Close the poll now? Nobody can vote after this, and the results appear for you. You can reopen it later.`) && run(async () => { await api.adminAction(sid, "close"); onClosed(); });
  };
  const remind = () =>
    run(async () => {
      const r = await api.adminRemind(sid);
      setReminded(`Reminder sent to ${r.reminded} ${r.reminded === 1 ? "person" : "people"} who have the poll open.`);
      setTimeout(() => setReminded(""), 5000);
    });
  const setClosing = (ms: number | null) => run(() => api.adminSettings(sid, { deadline: ms }));

  return (
    <section class="panel" aria-labelledby="h-controls">
      <h2 id="h-controls">{open ? "This poll is open" : "This poll is closed"}</h2>
      {open ? (
        <>
          <p>
            {deadline !== null
              ? <>It closes by itself on <strong>{formatWhen(deadline)}</strong> ({untilText(deadline, now)}), and the results appear for you then.</>
              : <>It has no closing time. Close it yourself when everyone has had a chance to vote.</>}
          </p>
          <div class="field">
            <label for="deadline">Closing time</label>
            <div class="row wrap">
              <input id="deadline" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
              <button class="secondary" disabled={picked === null || picked === deadline} onClick={() => picked !== null && setClosing(picked)}>Save closing time</button>
              <button class="secondary" onClick={() => setClosing((deadline ?? Date.now()) + 24 * 3600_000)}>+1 day</button>
              <button class="secondary" onClick={() => setClosing((deadline ?? Date.now()) + 7 * 24 * 3600_000)}>+1 week</button>
              {deadline !== null && <button class="link" onClick={() => setClosing(null)}>Remove closing time</button>}
            </div>
            <span class="hint">Shown in your time zone. Everyone sees the same moment in theirs.</span>
          </div>
          <p class="row"><button class="primary" onClick={closeNow}>Close poll now</button></p>
          <div class="pending">
            {counts.joined === 0 ? <p class="hint">Nobody has joined yet. Share the participant link above.</p>
              : pending.length === 0 ? <p class="ok">Everyone who joined has submitted.</p>
              : (
                <>
                  <p><strong>Joined but not submitted ({pending.length}):</strong> {pending.join(", ")}</p>
                  <button class="secondary" onClick={remind}>Remind them</button>
                  <p class="hint">Reminders only reach people who have the poll open right now. For everyone else, send the link again.</p>
                </>
              )}
            <span role="status" class="ok">{reminded}</span>
          </div>
        </>
      ) : (
        <>
          <p>It closed{deadline !== null && deadline <= now ? <> on {formatWhen(deadline)}</> : null}. Nobody can vote now. The results are in the Results tab.</p>
          <div class="row wrap">
            <button class="primary" onClick={onPresent}>Present full screen</button>
            <button class="secondary" onClick={() => run(() => api.downloadResultsCsv(sid, state.board.title))}>Download results (CSV)</button>
          </div>
          <p class="hint">Download the CSV and keep it. Hosting can erase polls, and you can rebuild these results later from the home page.</p>
          <div class="field reopen">
            <label for="reopen-when">Reopen the poll</label>
            <div class="row wrap">
              <input id="reopen-when" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} aria-describedby="reopen-hint" />
              <button
                class="secondary" disabled={when !== "" && picked === null}
                onClick={() => confirm("Reopen this poll? The results are hidden again and people can change their votes.") && run(() => api.adminAction(sid, "reopen", undefined, { deadline: when === "" ? null : picked }))}
              >
                Reopen
              </button>
            </div>
            <span class="hint" id="reopen-hint">Choose a new closing time, or leave it empty to reopen with no closing time.</span>
          </div>
        </>
      )}
    </section>
  );
}

function fmtDuration(sec: number) {
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function Controls({ sid, state, run, onRevealed, onPresent }: { sid: string; state: FacilitatorState; run: Run; onRevealed: () => void; onPresent: () => void }) {
  const { settings } = state;
  const { phase, timer } = settings;
  const noIdeas = state.ideas.length === 0;
  const suggested = state.ideas.filter((i) => i.author).length;
  const startWarning = `Start voting now?

Once voting starts, participants can no longer add their own options${suggested ? ` (${suggested} suggested so far)` : ""}. You can still edit the poll yourself.`;
  const pending = state.counts.pending;
  const lockWarning = pending.length
    ? `${pending.length} ${pending.length === 1 ? "person hasn't" : "people haven't"} submitted yet: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? `, and ${pending.length - 8} more` : ""}.\n\nLock voting anyway? Their votes so far will still be counted.`
    : "Lock voting? Participants will no longer be able to change their votes.";
  const [reminded, setReminded] = useState("");
  const remind = () =>
    run(async () => {
      const r = await api.adminRemind(sid);
      setReminded(`Reminder sent to ${r.reminded} ${r.reminded === 1 ? "person" : "people"}.`);
      setTimeout(() => setReminded(""), 5000);
    });
  const startLabel = timer.durationSec ? `Start voting (${fmtDuration(timer.durationSec)} timer)` : "Start voting (no timer)";
  const act = (action: string, seconds?: number) => run(() => api.adminAction(sid, action, seconds));

  return (
    <section class="panel" aria-labelledby="h-controls">
      <h2 id="h-controls">Controls</h2>
      {phase === "setup" && (
        <>
          <TimerPicker sid={sid} durationSec={timer.durationSec} run={run} />
          <p class="notice warn" role="note">
            <strong>Heads up:</strong> once you start voting, participants can no longer add their own options. Finish adding options first.
            {suggested > 0 && <> {suggested} {suggested === 1 ? "option has" : "options have"} been suggested by participants so far.</>}
          </p>
          <p class="row">
            <button class="primary" disabled={noIdeas} onClick={() => confirm(startWarning) && act("start")}>{startLabel}</button>
            {noIdeas && <span class="hint">Add options on the “Build the poll” tab first.</span>}
          </p>
        </>
      )}
      {phase === "voting" && (
        <div class="row wrap">
          {timer.state === "running" && <button class="secondary" onClick={() => act("pause")}>Pause timer</button>}
          {timer.state === "paused" && <button class="secondary" onClick={() => act("resume")}>Resume timer</button>}
          <button class="secondary" onClick={() => act("extend", 60)}>+1 min</button>
          <button class="secondary" onClick={() => act("extend", 300)}>+5 min</button>
          <button class="primary" onClick={() => confirm(lockWarning) && act("lock")}>Lock voting</button>
        </div>
      )}
      {phase === "locked" && (
        <>
          <div class="row wrap">
            <button class="primary" onClick={() => run(async () => { await api.adminAction(sid, "reveal"); onRevealed(); })}>Reveal results</button>
            <button class="secondary" onClick={() => act("reopen")}>Reopen voting</button>
            <button class="secondary" onClick={() => act("extend", 120)}>Reopen for 2 more min</button>
          </div>
          <p class="hint">Voting is locked. Results stay hidden from everyone, including you, until you reveal them.</p>
        </>
      )}
      {phase === "revealed" && (
        <div class="row wrap">
          <button class="primary" onClick={onPresent}>Present full screen</button>
          <button class="secondary" onClick={() => run(() => api.downloadResultsCsv(sid, state.board.title))}>Download results (CSV)</button>
          <button class="secondary" onClick={() => act("hide")}>Hide results</button>
        </div>
      )}
      {phase === "revealed" && (
        <p class="hint">Download the CSV and keep it. Hosting can erase polls, and you can rebuild these results later from the home page.</p>
      )}
      {phase === "voting" && (
        <div class="pending">
          {pending.length === 0 ? (
            <p class="ok">Everyone who joined has submitted.</p>
          ) : (
            <>
              <p><strong>Not submitted yet ({pending.length}):</strong> {pending.join(", ")}</p>
              <button class="secondary" onClick={remind}>Remind {pending.length === 1 ? "them" : "everyone"} to submit</button>
            </>
          )}
          <span role="status" class="ok">{reminded}</span>
        </div>
      )}
      {phase === "voting" && timer.durationSec === null && timer.state === "stopped" && <p class="hint">No timer is running. Lock voting when everyone is done.</p>}
    </section>
  );
}

function TimerPicker({ sid, durationSec, run }: { sid: string; durationSec: number | null; run: Run }) {
  const isPreset = durationSec !== null && PRESETS.includes(durationSec / 60) && durationSec % 60 === 0;
  const [custom, setCustom] = useState(durationSec !== null && !isPreset);
  const [minutes, setMinutes] = useState(durationSec !== null && !isPreset ? String(durationSec / 60) : "");
  const value = custom ? "custom" : durationSec === null ? "none" : String(durationSec / 60);

  const choose = (v: string) => {
    if (v === "custom") return setCustom(true);
    setCustom(false);
    run(() => api.adminSettings(sid, { timerSeconds: v === "none" ? null : Number(v) * 60 }));
  };

  return (
    <div class="field">
      <label for="timer">Quiet voting time</label>
      <div class="row">
        <select id="timer" value={value} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>
          <option value="none">No timer</option>
          {PRESETS.map((m) => <option value={m} key={m}>{m} {m === 1 ? "minute" : "minutes"}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {custom && (
          <>
            <input
              type="number" min="0.25" step="any" inputMode="decimal" aria-label="Custom minutes" value={minutes} style="width:6rem"
              onInput={(e) => setMinutes((e.target as HTMLInputElement).value)}
              onChange={() => minutes && run(() => api.adminSettings(sid, { timerSeconds: Math.round(Number(minutes) * 60) }))}
            />
            <span>minutes</span>
          </>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({ sid, state, run }: { sid: string; state: FacilitatorState; run: Run }) {
  const s = state.settings;
  const setup = s.phase === "setup";
  const set = (patch: Record<string, unknown>) => run(() => api.adminSettings(sid, patch));
  const num = (key: string) => (e: Event) => set({ [key]: Number((e.target as HTMLInputElement).value) });
  return (
    <section class="panel" aria-labelledby="h-settings">
      <h2 id="h-settings">Settings</h2>
      <fieldset class="field method-field">
        <legend>How people vote</legend>
        {METHODS.map((m) => (
          <label class="method-option" key={m.id}>
            <input type="radio" name="method" checked={s.method === m.id} disabled={!setup} onChange={() => set({ method: m.id })} />
            <span><strong>{m.label}</strong><span class="hint">{m.blurb}</span></span>
          </label>
        ))}
        {!setup && <span class="hint">{s.mode === "poll" ? "The voting method cannot change once the poll is open." : "The voting method is locked once voting starts."}</span>}
      </fieldset>
      <div class="grid">
        {s.method === "dots" && (
          <div class="field">
            <label for="votes">Votes per person</label>
            <input id="votes" type="number" min="1" max="20" value={s.votesPerPerson} disabled={!setup} onChange={num("votesPerPerson")} />
            {!setup && <span class="hint">{s.mode === "poll" ? "Locked once the poll is open." : "Locked once voting starts."}</span>}
          </div>
        )}
        <fieldset class="field">
          <legend>Results show</legend>
          <label class="inline"><input type="radio" name="named" disabled={s.phase === "revealed"} checked={!s.namedResults} onChange={() => set({ namedResults: false })} /> Anonymous totals</label>
          <label class="inline"><input type="radio" name="named" disabled={s.phase === "revealed"} checked={s.namedResults} onChange={() => set({ namedResults: true })} /> Who voted for what</label>
        </fieldset>
        {s.mode === "live" && (
          <div class="field">
            <label class="inline">
              <input type="checkbox" checked={s.ideasOpen} onChange={(e) => set({ ideasOpen: (e.target as HTMLInputElement).checked })} />
              Participants can add their own options (before voting starts)
            </label>
            <label for="per">Options each person can add</label>
            <input id="per" type="number" min="1" max="20" value={s.ideasPerPerson} onChange={num("ideasPerPerson")} />
          </div>
        )}
        {s.mode === "live" && (
          <div class="field">
            <label class="inline">
              <input type="checkbox" checked={s.autoLock} onChange={(e) => set({ autoLock: (e.target as HTMLInputElement).checked })} />
              Lock voting automatically when time runs out
            </label>
            <span class="hint">Off: time runs out and you decide when to lock.</span>
          </div>
        )}
        {s.mode === "poll" && (
          <div class="field">
            <label class="inline">
              <input type="checkbox" checked={s.shareResults} onChange={(e) => set({ shareResults: (e.target as HTMLInputElement).checked })} />
              Let participants see the results after the poll closes
            </label>
            <span class="hint">They only see totals, never who voted for what.</span>
          </div>
        )}
      </div>
    </section>
  );
}

const listNames = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);

/** One line about a person: device, when they joined and submitted, and how long it took. */
function personDetails(p: api.Person): string {
  const parts = [
    p.device,
    p.joinedAt !== null ? `Joined ${formatWhen(p.joinedAt)}` : "",
    p.submittedAt !== null ? `Submitted ${formatWhen(p.submittedAt)}` : "",
    p.tookMs !== null ? `took ${tookText(p.tookMs)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No details, because this person joined before details were recorded.";
}

/** Test votes: see who joined, remove one person's votes, or clear every response and start collecting again. */
function ResponsesPanel({ sid, state, run }: { sid: string; state: FacilitatorState; run: Run }) {
  const { counts, settings } = state;
  const [info, setInfo] = useState<api.People | null>(null);
  useEffect(() => {
    let live = true;
    api.adminPeople(sid).then((p) => live && setInfo(p)).catch(() => {});
    return () => { live = false; };
  }, [sid, counts.joined, counts.submitted, settings.phase]);

  const people = info?.people ?? [];
  const risky = !!info?.risky;
  const removeOne = (name: string) =>
    confirm(
      risky
        ? `Remove ${name} and everything they voted?\n\n${info!.warning}\n\nRemove them anyway? This cannot be undone.`
        : `Remove ${name} and everything they voted?\n\nThe totals will not include them. They can join again, even with the same name. This cannot be undone.`,
    ) && run(() => api.adminRemovePerson(sid, name, risky));
  const clearAll = () =>
    confirm(`Clear all responses?\n\nThis removes ${counts.joined} ${counts.joined === 1 ? "person" : "people"} and every vote. The poll, its options and its settings stay, and it stays ${settings.phase === "voting" ? "open" : "as it is"}. Anyone who has the poll open will be asked to join again. This cannot be undone.`) &&
    run(() => api.adminClearResponses(sid));

  return (
    <section class="panel" aria-labelledby="h-responses">
      <h2 id="h-responses">Responses</h2>
      {counts.joined === 0 ? (
        <p class="hint">Nobody has joined yet. If you or others try the poll before it is real, you can remove those test votes here, one person at a time or all at once.</p>
      ) : (
        <>
          <p class="hint">Remove test votes or repeats so they are not counted. You see details about each person, never what anyone picked.</p>
          {risky && <p class="notice warn" role="note">{info!.warning} You will be asked to confirm before removing someone. Clearing all responses never has this effect.</p>}
          {people.some((p) => p.sameNetwork.length || p.similarNames.length) && (
            <p class="notice" role="note">
              Some people may have voted more than once. Look for the notes under their names. They are hints, not proof: people in the same office share a network, and two people can have similar names. To keep only the latest response, remove the earlier one.
            </p>
          )}
          <ul class="people">
            {people.map((p) => (
              <li key={p.name}>
                <div class="who-row">
                  <span class="who-name">{p.name}</span>
                  <span class="hint">{p.submitted ? "Submitted" : "Not submitted"}</span>
                  <button class="secondary" onClick={() => removeOne(p.name)} aria-label={`Remove ${p.name} and their votes`}>Remove</button>
                </div>
                <p class="hint person-meta">{personDetails(p)}</p>
                {p.sameNetwork.length > 0 && <p class="flag">Connected from the same network as {listNames(p.sameNetwork)}.</p>}
                {p.similarNames.length > 0 && <p class="flag">Name looks like {listNames(p.similarNames)}.</p>}
              </li>
            ))}
          </ul>
          <p class="row"><button class="danger" onClick={clearAll}>Clear all responses</button></p>
        </>
      )}
    </section>
  );
}

function DeletePanel({ sid, title, run }: { sid: string; title: string; run: Run }) {
  const remove = () => {
    if (!confirm(`Delete "${title}" for good?

Its options, participants and votes are erased, participants lose access, and its links stop working. Download the results first if you need them. This cannot be undone.`)) return;
    run(async () => {
      await api.adminDeleteBoard(sid);
      api.forgetAdminKey(sid);
      location.assign("/");
    });
  };
  return (
    <section class="panel danger-zone" aria-labelledby="h-delete">
      <h2 id="h-delete">Delete this poll</h2>
      <p class="hint">Removes the poll, its options, participants and votes. Polls are also deleted automatically after 90 days without use.</p>
      <button class="danger" onClick={remove}>Delete this poll</button>
    </section>
  );
}
