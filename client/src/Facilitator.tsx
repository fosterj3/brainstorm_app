import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { FacilitatorIdea, FacilitatorState } from "./api";
import { Countdown } from "./Countdown";
import { groupByTheme } from "./App";

const PRESETS = [1, 2, 3, 5, 10, 15, 20, 30];
const PHASE_LABEL = { setup: "Setting up", voting: "Voting open", locked: "Voting locked" } as const;

export function Facilitator() {
  const [signedIn, setSignedIn] = useState(!!api.getFacToken());
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;
  return (
    <Dashboard
      onSignOut={() => {
        api.setFacToken("");
        setSignedIn(false);
      }}
    />
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.facilitatorLogin(passcode);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <main class="page narrow">
      <h1>Facilitator sign-in</h1>
      <form onSubmit={submit}>
        <label for="pass">Passcode</label>
        <input
          id="pass" type="password" value={passcode} autoFocus autocomplete="current-password"
          aria-describedby={error ? "pass-error" : undefined} aria-invalid={error ? "true" : undefined}
          onInput={(e) => setPasscode((e.target as HTMLInputElement).value)}
        />
        {error && <p id="pass-error" role="alert" class="error">{error}</p>}
        <button class="primary" type="submit" disabled={busy || !passcode}>Sign in</button>
      </form>
    </main>
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [state, setState] = useState<FacilitatorState | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);

  const refresh = () =>
    api
      .facState()
      .then((s) => {
        setOffset(s.serverNow - Date.now());
        setState(s);
      })
      .catch((e: api.ApiError) => (e.code === "unauthorized" ? onSignOut() : setError(e.message)));

  useEffect(() => {
    refresh();
    return api.connectLive("facilitator", {
      onOpen: refresh,
      onStatus: setOnline,
      onPush: (m) => {
        if (m.type === "refresh") refresh();
        if (m.type === "counts") setState((s) => (s ? { ...s, counts: { joined: m.joined, connected: m.connected, submitted: m.submitted } } : s));
      },
    });
  }, []);

  /** Run a facilitator action, surfacing any error; the server pushes the new state back to us. */
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      const err = e as api.ApiError;
      if (err.code === "unauthorized") onSignOut();
      else setError(err.message);
    }
  };

  if (!state) return <main class="page"><p>{error || "Loading…"}</p></main>;
  const { settings, counts, ideas } = state;
  const { phase, timer } = settings;

  return (
    <>
      <header class="bar">
        <div class="bar-inner">
          <strong>Facilitator</strong>
          <span class="phase" data-phase={phase}>{PHASE_LABEL[phase]}</span>
          {timer.state !== "stopped" && <Countdown timer={timer} offset={offset} />}
          <button class="link" onClick={onSignOut}>Sign out</button>
        </div>
        {!online && <p class="offline" role="status">Reconnecting…</p>}
      </header>
      <main class="page wide">
        <p role="alert" class="error" hidden={!error}>{error}</p>

        <section class="panel" aria-labelledby="h-people">
          <h2 id="h-people">Participants</h2>
          <p class="stats">
            <span><strong>{counts.joined}</strong> joined</span>
            <span><strong>{counts.connected}</strong> online now</span>
            <span><strong>{counts.submitted}</strong> of {counts.joined} submitted</span>
          </p>
          <ShareLink />
          <p class="hint">You see only how many people have submitted, never what anyone picked.</p>
        </section>

        <Controls state={state} run={run} />
        <SettingsPanel state={state} run={run} />
        <IdeasPanel ideas={ideas} phase={phase} run={run} />
      </main>
    </>
  );
}

function ShareLink() {
  const link = `${location.origin}/`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the link is still selectable */
    }
  };
  return (
    <div class="share">
      <label for="share-link">Link for participants</label>
      <div class="row">
        <input id="share-link" readOnly value={link} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <button class="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;

function Controls({ state, run }: { state: FacilitatorState; run: Run }) {
  const { settings } = state;
  const { phase, timer } = settings;
  const noIdeas = state.ideas.length === 0;
  const startLabel = timer.durationSec ? `Start voting (${fmtDuration(timer.durationSec)} timer)` : "Start voting (no timer)";

  return (
    <section class="panel" aria-labelledby="h-controls">
      <h2 id="h-controls">Controls</h2>
      {phase === "setup" && (
        <>
          <TimerPicker durationSec={timer.durationSec} run={run} />
          <p class="row">
            <button class="primary" disabled={noIdeas} onClick={() => run(() => api.facAction("start"))}>{startLabel}</button>
            {noIdeas && <span class="hint">Add or import ideas first.</span>}
          </p>
        </>
      )}
      {phase === "voting" && (
        <div class="row wrap">
          {timer.state === "running" && <button class="secondary" onClick={() => run(() => api.facAction("pause"))}>Pause timer</button>}
          {timer.state === "paused" && <button class="secondary" onClick={() => run(() => api.facAction("resume"))}>Resume timer</button>}
          <button class="secondary" onClick={() => run(() => api.facAction("extend", 60))}>+1 min</button>
          <button class="secondary" onClick={() => run(() => api.facAction("extend", 300))}>+5 min</button>
          <button class="primary" onClick={() => confirm("Lock voting? Participants will no longer be able to change their stars.") && run(() => api.facAction("lock"))}>
            Lock voting
          </button>
        </div>
      )}
      {phase === "locked" && (
        <div class="row wrap">
          <button class="secondary" onClick={() => run(() => api.facAction("reopen"))}>Reopen voting</button>
          <button class="secondary" onClick={() => run(() => api.facAction("extend", 120))}>Reopen for 2 more min</button>
        </div>
      )}
      {phase === "voting" && timer.durationSec === null && timer.state === "stopped" && <p class="hint">No timer is running. Lock voting when everyone is done.</p>}
    </section>
  );
}

function fmtDuration(sec: number) {
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function TimerPicker({ durationSec, run }: { durationSec: number | null; run: Run }) {
  const isPreset = durationSec !== null && PRESETS.includes(durationSec / 60) && durationSec % 60 === 0;
  const [custom, setCustom] = useState(durationSec !== null && !isPreset);
  const [minutes, setMinutes] = useState(durationSec !== null && !isPreset ? String(durationSec / 60) : "");
  const value = custom ? "custom" : durationSec === null ? "none" : String(durationSec / 60);

  const choose = (v: string) => {
    if (v === "custom") return setCustom(true);
    setCustom(false);
    run(() => api.facSettings({ timerSeconds: v === "none" ? null : Number(v) * 60 }));
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
              onChange={() => minutes && run(() => api.facSettings({ timerSeconds: Math.round(Number(minutes) * 60) }))}
            />
            <span>minutes</span>
          </>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({ state, run }: { state: FacilitatorState; run: Run }) {
  const s = state.settings;
  const setup = s.phase === "setup";
  const num = (key: string) => (e: Event) => run(() => api.facSettings({ [key]: Number((e.target as HTMLInputElement).value) }));
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
          <label class="inline"><input type="radio" name="named" checked={!s.namedResults} onChange={() => run(() => api.facSettings({ namedResults: false }))} /> Anonymous totals</label>
          <label class="inline"><input type="radio" name="named" checked={s.namedResults} onChange={() => run(() => api.facSettings({ namedResults: true }))} /> Who starred what</label>
        </fieldset>
        <div class="field">
          <label class="inline">
            <input type="checkbox" checked={s.ideasOpen} onChange={(e) => run(() => api.facSettings({ ideasOpen: (e.target as HTMLInputElement).checked }))} />
            Participants can suggest ideas (before voting starts)
          </label>
          <label for="per">Ideas each person can add</label>
          <input id="per" type="number" min="1" max="20" value={s.ideasPerPerson} onChange={num("ideasPerPerson")} />
        </div>
        <div class="field">
          <label class="inline">
            <input type="checkbox" checked={s.autoLock} onChange={(e) => run(() => api.facSettings({ autoLock: (e.target as HTMLInputElement).checked }))} />
            Lock voting automatically when time runs out
          </label>
          <span class="hint">Off: time runs out and you decide when to lock.</span>
        </div>
      </div>
    </section>
  );
}

function IdeasPanel({ ideas, phase, run }: { ideas: FacilitatorIdea[]; phase: string; run: Run }) {
  const groups = groupByTheme(ideas);
  return (
    <section class="panel" aria-labelledby="h-ideas">
      <h2 id="h-ideas">Ideas ({ideas.length})</h2>
      <AddIdea run={run} />
      <ImportIdeas phase={phase} run={run} />
      {ideas.length === 0 && <p class="empty">No ideas yet.</p>}
      {groups.map(([theme, items]) => (
        <div key={theme}>
          <h3 class="theme-h">{theme}</h3>
          <ul class="idea-list">
            {items.map((i) => <IdeaRow key={i.id} idea={i} all={ideas} run={run} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function AddIdea({ run }: { run: Run }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [theme, setTheme] = useState("");
  const submit = (e: Event) => {
    e.preventDefault();
    run(async () => {
      await api.facAddIdea({ title, description, theme });
      setTitle(""); setDescription(""); setTheme("");
    });
  };
  return (
    <form class="inline-form" onSubmit={submit} aria-label="Add an idea">
      <input aria-label="Title" placeholder="Title" value={title} maxLength={120} required onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      <input aria-label="Description" placeholder="Description" value={description} maxLength={400} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      <input aria-label="Theme" placeholder="Theme (optional)" value={theme} maxLength={60} onInput={(e) => setTheme((e.target as HTMLInputElement).value)} />
      <button class="primary" type="submit" disabled={!title.trim()}>Add</button>
    </form>
  );
}

function ImportIdeas({ phase, run }: { phase: string; run: Run }) {
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [message, setMessage] = useState("");

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
    const content = await file.text();
    setMessage("");
    await run(async () => {
      const r = await api.facImport(format, content, mode);
      setMessage(`Imported ${r.added} ${r.added === 1 ? "idea" : "ideas"}${r.skipped ? `, skipped ${r.skipped} without a title` : ""}.`);
    });
    input.value = "";
  };

  return (
    <div class="import">
      <label for="import-file">Import from CSV or JSON</label>
      <div class="row wrap">
        <input id="import-file" type="file" accept=".csv,.json,text/csv,application/json" onChange={onFile} />
        <label class="inline">
          <input type="radio" name="mode" checked={mode === "append"} onChange={() => setMode("append")} /> Add to existing
        </label>
        <label class="inline">
          <input type="radio" name="mode" checked={mode === "replace"} disabled={phase !== "setup"} onChange={() => setMode("replace")} /> Replace all
        </label>
      </div>
      <p class="hint">CSV needs a header row with <code>title</code>, and optionally <code>description</code> and <code>theme</code>. JSON is a list of objects with the same fields.</p>
      {message && <p role="status" class="ok">{message}</p>}
    </div>
  );
}

function IdeaRow({ idea, all, run }: { idea: FacilitatorIdea; all: FacilitatorIdea[]; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [title, setTitle] = useState(idea.title);
  const [description, setDescription] = useState(idea.description);
  const [theme, setTheme] = useState(idea.theme);
  const [target, setTarget] = useState("");

  if (editing) {
    return (
      <li class="idea-row">
        <form class="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api.facEditIdea(idea.id, { title, description, theme })).then(() => setEditing(false)); }}>
          <input aria-label="Title" value={title} maxLength={120} required onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <input aria-label="Description" value={description} maxLength={400} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
          <input aria-label="Theme" value={theme} maxLength={60} onInput={(e) => setTheme((e.target as HTMLInputElement).value)} />
          <button class="primary" type="submit">Save</button>
          <button class="secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      </li>
    );
  }

  return (
    <li class="idea-row">
      <div class="idea-text">
        <strong>{idea.title}</strong>
        {idea.description && <span> — {idea.description}</span>}
        {idea.author && <span class="by"> (suggested by {idea.author})</span>}
      </div>
      <div class="row wrap actions">
        <button class="secondary" onClick={() => setEditing(true)} aria-label={`Edit ${idea.title}`}>Edit</button>
        <button class="secondary" onClick={() => setMerging(!merging)} aria-expanded={merging} aria-label={`Merge ${idea.title} into another idea`}>Merge…</button>
        <button
          class="danger" aria-label={`Delete ${idea.title}`}
          onClick={() => confirm(`Delete "${idea.title}"? Any stars on it go back to the people who used them.`) && run(() => api.facDeleteIdea(idea.id))}
        >
          Delete
        </button>
      </div>
      {merging && (
        <div class="row merge">
          <label for={`merge-${idea.id}`}>Merge into</label>
          <select id={`merge-${idea.id}`} value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
            <option value="">Choose an idea…</option>
            {all.filter((o) => o.id !== idea.id).map((o) => <option value={o.id} key={o.id}>{o.title}</option>)}
          </select>
          <button
            class="primary" disabled={!target}
            onClick={() => confirm(`Merge "${idea.title}" into the chosen idea? Its stars move across, and "${idea.title}" is removed.`) && run(() => api.facMerge(idea.id, Number(target)))}
          >
            Merge
          </button>
        </div>
      )}
    </li>
  );
}
