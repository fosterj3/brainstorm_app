import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { FacilitatorState } from "./api";
import { Board } from "./Board";
import { BoardEditor, type Run } from "./BoardEditor";
import { Countdown } from "./Countdown";
import { FacilitatorHelp } from "./Help";
import { Presentation, ResultsPanel } from "./Results";

const PRESETS = [1, 2, 3, 5, 10, 15, 20, 30];
const PHASE_LABEL = { setup: "Setting up", voting: "Voting open", locked: "Voting locked", revealed: "Results showing" } as const;
type Tab = "run" | "build" | "preview" | "results";

/** The facilitator's secret arrives in the link's #fragment (never sent to the server); keep it on this device. */
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
        <h1>Facilitator link needed</h1>
        <p>This device does not have facilitator access to this session. Open the private facilitator link you were given when you created it.</p>
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
    if (state) document.title = `${state.board.title} (facilitator)`;
  }, [state?.board.title]);

  /** Run a facilitator action, surfacing any error; the server pushes the new state back to us. */
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

  if (!state) return <main class="page"><p>{error || "Loading…"}</p></main>;
  const { settings, counts } = state;
  const { phase, timer } = settings;

  const tabs: [Tab, string][] = [["run", "Run the session"], ["build", "Build the board"], ["preview", "Preview"], ["results", "Results"]];

  return (
    <>
      <header class="bar">
        <div class="bar-inner">
          <strong class="bar-title">{state.board.title}</strong>
          <span class="phase" data-phase={phase}>{PHASE_LABEL[phase]}</span>
          {timer.state !== "stopped" && <Countdown timer={timer} offset={offset} />}
          {counts.joined > 0 && <span class="hint">{counts.submitted} of {counts.joined} submitted</span>}
          <a href="/" class="hint">My boards</a>
        </div>
        {!online && <p class="offline" role="status">Reconnecting…</p>}
      </header>
      <main class="page wide">
        <FacilitatorHelp />
        <div class="tabs" role="tablist" aria-label="Facilitator sections">
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
              <SharePanel sid={sid} counts={counts} />
              <Controls sid={sid} state={state} run={run} onRevealed={() => setTab("results")} onPresent={() => setPresenting(true)} />
              <SettingsPanel sid={sid} state={state} run={run} />
              <DeletePanel sid={sid} title={state.board.title} run={run} />
            </>
          )}
          {tab === "build" && (
            <>
              {phase !== "setup" && (
                <p class="notice warn" role="note">
                  Voting has started, so participants can no longer add their own ideas. You can still edit the board yourself, but changing or deleting ideas now affects the votes already cast.
                </p>
              )}
              <BoardEditor sid={sid} state={state} run={run} />
            </>
          )}
          {tab === "preview" && <Preview state={state} />}
          {tab === "results" && (
            <ResultsPanel sid={sid} title={state.board.title} columns={state.columns} revealed={settings.phase === "revealed"} onPresent={() => setPresenting(true)} run={run} />
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
    <section aria-label="Board preview">
      <p class="hint">This is what participants see, without stars.</p>
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

function SharePanel({ sid, counts }: { sid: string; counts: FacilitatorState["counts"] }) {
  const key = api.getAdminKey(sid);
  return (
    <section class="panel" aria-labelledby="h-share">
      <h2 id="h-share">Share and participants</h2>
      <CopyField id="share-link" label="Link for participants" value={`${location.origin}/s/${sid}`} note={`Or give them the code ${sid} on the home page.`} />
      <CopyField
        id="admin-link" label="Your private facilitator link"
        value={`${location.origin}/f/${sid}#${key}`}
        note="Keep this to yourself and bookmark it. Anyone with it can run this session, and it is the only way back in from another device."
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

function fmtDuration(sec: number) {
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function Controls({ sid, state, run, onRevealed, onPresent }: { sid: string; state: FacilitatorState; run: Run; onRevealed: () => void; onPresent: () => void }) {
  const { settings } = state;
  const { phase, timer } = settings;
  const noIdeas = state.ideas.length === 0;
  const suggested = state.ideas.filter((i) => i.author).length;
  const startWarning = `Start voting now?

Once voting starts, participants can no longer add their own ideas${suggested ? ` (${suggested} suggested so far)` : ""}. You can still edit the board yourself.`;
  const pending = state.counts.pending;
  const lockWarning = pending.length
    ? `${pending.length} ${pending.length === 1 ? "person hasn't" : "people haven't"} submitted yet: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? `, and ${pending.length - 8} more` : ""}.\n\nLock voting anyway? Their stars so far will still be counted.`
    : "Lock voting? Participants will no longer be able to change their stars.";
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
            <strong>Heads up:</strong> once you start voting, participants can no longer add their own ideas. Finish adding ideas first.
            {suggested > 0 && <> {suggested} {suggested === 1 ? "idea has" : "ideas have"} been suggested by participants so far.</>}
          </p>
          <p class="row">
            <button class="primary" disabled={noIdeas} onClick={() => confirm(startWarning) && act("start")}>{startLabel}</button>
            {noIdeas && <span class="hint">Add ideas on the “Build the board” tab first.</span>}
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
        <p class="hint">Download the CSV and keep it. Hosting can erase boards, and you can rebuild these results later from the home page.</p>
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
      <div class="grid">
        <div class="field">
          <label for="votes">Stars per person</label>
          <input id="votes" type="number" min="1" max="20" value={s.votesPerPerson} disabled={!setup} onChange={num("votesPerPerson")} />
          {!setup && <span class="hint">Locked once voting starts.</span>}
        </div>
        <fieldset class="field">
          <legend>Results show</legend>
          <label class="inline"><input type="radio" name="named" disabled={s.phase === "revealed"} checked={!s.namedResults} onChange={() => set({ namedResults: false })} /> Anonymous totals</label>
          <label class="inline"><input type="radio" name="named" disabled={s.phase === "revealed"} checked={s.namedResults} onChange={() => set({ namedResults: true })} /> Who starred what</label>
        </fieldset>
        <div class="field">
          <label class="inline">
            <input type="checkbox" checked={s.ideasOpen} onChange={(e) => set({ ideasOpen: (e.target as HTMLInputElement).checked })} />
            Participants can add their own ideas (before voting starts)
          </label>
          <label for="per">Ideas each person can add</label>
          <input id="per" type="number" min="1" max="20" value={s.ideasPerPerson} onChange={num("ideasPerPerson")} />
        </div>
        <div class="field">
          <label class="inline">
            <input type="checkbox" checked={s.autoLock} onChange={(e) => set({ autoLock: (e.target as HTMLInputElement).checked })} />
            Lock voting automatically when time runs out
          </label>
          <span class="hint">Off: time runs out and you decide when to lock.</span>
        </div>
      </div>
    </section>
  );
}

function DeletePanel({ sid, title, run }: { sid: string; title: string; run: Run }) {
  const remove = () => {
    if (!confirm(`Delete "${title}" for good?

Its ideas, participants and votes are erased, participants lose access, and its links stop working. Download the results first if you need them. This cannot be undone.`)) return;
    run(async () => {
      await api.adminDeleteBoard(sid);
      api.forgetAdminKey(sid);
      location.assign("/");
    });
  };
  return (
    <section class="panel danger-zone" aria-labelledby="h-delete">
      <h2 id="h-delete">Delete this board</h2>
      <p class="hint">Removes the board, its ideas, participants and votes. Boards are also deleted automatically after 90 days without use.</p>
      <button class="danger" onClick={remove}>Delete this board</button>
    </section>
  );
}
