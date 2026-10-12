import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "./api";
import type { Idea, Session } from "./api";
import { Countdown } from "./Countdown";

const NO_THEME = "Other ideas";

export function groupByTheme<T extends Idea>(ideas: T[]) {
  const groups = new Map<string, T[]>();
  for (const idea of ideas) {
    const key = idea.theme || NO_THEME;
    groups.set(key, [...(groups.get(key) ?? []), idea]);
  }
  // Unthemed ideas go last.
  return [...groups.entries()].sort(([a], [b]) => (a === NO_THEME ? 1 : b === NO_THEME ? -1 : 0));
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const joined = !!session?.me;

  const refresh = () =>
    api
      .fetchSession()
      .then((s) => {
        setOffset(s.serverNow - Date.now());
        setSession(s);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  // Live updates. Every (re)connect refetches, so a refresh, sleep or network drop never loses state.
  useEffect(() => {
    if (!joined) return;
    return api.connectLive("participant", {
      onOpen: refresh,
      onStatus: setOnline,
      onPush: (m) => {
        if (m.type === "refresh") refresh();
        else if (m.type === "ideas") setSession((s) => (s ? { ...s, ideas: m.ideas } : s));
        else if (m.type === "votes") setSession((s) => (s && s.me ? { ...s, me: { ...s.me, votes: m.votes } } : s));
      },
    });
  }, [joined]);

  if (error && !session) return <main class="page"><p role="alert" class="error">{error}</p></main>;
  if (!session) return <main class="page"><p>Loading…</p></main>;
  if (!session.me) return <JoinForm onJoined={refresh} />;
  return <Voting session={session} setSession={setSession} refresh={refresh} online={online} offset={offset} />;
}

function JoinForm({ onJoined }: { onJoined: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.join(name);
      onJoined();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main class="page narrow">
      <h1>Join the session</h1>
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
    </main>
  );
}

type SetSession = (f: (s: Session | null) => Session | null) => void;

function Voting(props: { session: Session; setSession: SetSession; refresh: () => void; online: boolean; offset: number }) {
  const { session, setSession, refresh, online, offset } = props;
  const { settings, ideas, me } = session;
  const votes = new Set(me!.votes);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupByTheme(ideas), [ideas]);
  const themes = useMemo(() => [...new Set(ideas.map((i) => i.theme).filter(Boolean))], [ideas]);
  const used = votes.size;
  const full = used >= settings.votesPerPerson;
  const voting = settings.phase === "voting";
  const { timer } = settings;

  const setVotes = (next: number[]) => setSession((s) => (s && s.me ? { ...s, me: { ...s.me, votes: next } } : s));

  const toggle = async (id: number) => {
    if (!voting) return;
    const next = !votes.has(id);
    const before = me!.votes;
    setError("");
    setVotes(next ? [...before, id] : before.filter((v) => v !== id)); // optimistic
    try {
      setVotes((await api.setVote(id, next)).votes);
    } catch (e) {
      setVotes(before);
      setError((e as Error).message);
      refresh(); // the phase may have changed (locked, reopened); pick up the truth
    }
  };

  const submit = async (submitted: boolean) => {
    setError("");
    try {
      await api.setSubmitted(submitted);
      setSession((s) => (s && s.me ? { ...s, me: { ...s.me, submitted } } : s));
    } catch (e) {
      setError((e as Error).message);
      refresh();
    }
  };

  const toggleGroup = (theme: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(theme) ? n.delete(theme) : n.add(theme);
      return n;
    });

  const canSuggest = settings.ideasOpen && settings.phase === "setup";

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
      <main class="page">
        <h1>Star your top {settings.votesPerPerson}</h1>
        <p class="lead">
          Choose the ideas you feel most strongly about adopting as a leadership priority. Your picks are private.
        </p>
        {settings.phase === "setup" && <p class="notice">Waiting for the facilitator to start voting. You can read the ideas now.</p>}
        {settings.phase === "locked" && <p class="notice">Voting is locked. Your stars are saved.</p>}
        {voting && timer.state === "paused" && <p class="notice">The facilitator paused the timer.</p>}
        {voting && timer.state === "ended" && <p class="notice">Time is up. The facilitator will lock voting shortly.</p>}
        <p role="alert" class="error" hidden={!error}>{error}</p>

        {voting && (
          <div class="submit-row">
            {me!.submitted ? (
              <>
                <span class="done">✓ Submitted. You can still change your stars until voting locks.</span>
                <button class="secondary" onClick={() => submit(false)}>Undo</button>
              </>
            ) : (
              <button class="primary" disabled={used === 0} onClick={() => submit(true)}>
                I'm done: submit my stars
              </button>
            )}
          </div>
        )}

        {canSuggest && <SuggestIdea settings={settings} added={me!.ideasAdded} themes={themes} onAdded={refresh} />}

        {ideas.length === 0 && <p class="empty">No ideas yet. They will appear here as soon as they are added.</p>}

        {groups.map(([theme, items]) => {
          const open = !collapsed.has(theme);
          const count = items.filter((i) => votes.has(i.id)).length;
          return (
            <section class="group" key={theme}>
              <h2>
                <button class="group-toggle" aria-expanded={open} aria-controls={`g-${theme}`} onClick={() => toggleGroup(theme)}>
                  <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
                  {theme}
                  <span class="meta">{items.length} {items.length === 1 ? "idea" : "ideas"}{count ? ` · ${count} starred` : ""}</span>
                </button>
              </h2>
              <ul id={`g-${theme}`} class="cards" hidden={!open}>
                {items.map((idea) => {
                  const on = votes.has(idea.id);
                  const blocked = !voting || (!on && full);
                  return (
                    <li key={idea.id} class={`card${on ? " on" : ""}`}>
                      <div class="text">
                        <h3>{idea.title}</h3>
                        {idea.description && <p>{idea.description}</p>}
                      </div>
                      <button
                        class="star" aria-pressed={on} aria-disabled={blocked}
                        aria-label={`${on ? "Remove star from" : "Star"} ${idea.title}`}
                        onClick={() => toggle(idea.id)}
                      >
                        <span aria-hidden="true">{on ? "★" : "☆"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </main>
    </>
  );
}

function SuggestIdea(props: { settings: Session["settings"]; added: number; themes: string[]; onAdded: () => void }) {
  const { settings, added, themes, onAdded } = props;
  const left = settings.ideasPerPerson - added;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [theme, setTheme] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (left <= 0) return <p class="lead">You have added all {settings.ideasPerPerson} of your ideas.</p>;

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.addIdea({ title, description, theme });
      setTitle(""); setDescription(""); setTheme(""); setOpen(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <button class="secondary" onClick={() => setOpen(true)}>
        + Suggest an idea <span class="meta">({left} left)</span>
      </button>
    );
  }

  return (
    <form class="suggest" onSubmit={submit} aria-labelledby="suggest-h">
      <h2 id="suggest-h">Suggest an idea</h2>
      <label for="s-title">Title</label>
      <input id="s-title" value={title} maxLength={120} required autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      <label for="s-desc">Description (one or two sentences)</label>
      <textarea id="s-desc" value={description} maxLength={400} rows={3} onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
      <label for="s-theme">Theme (optional)</label>
      <input id="s-theme" list="themes" value={theme} maxLength={60} onInput={(e) => setTheme((e.target as HTMLInputElement).value)} />
      <datalist id="themes">{themes.map((t) => <option value={t} key={t} />)}</datalist>
      <p role="alert" class="error" hidden={!error}>{error}</p>
      <div class="row">
        <button class="primary" type="submit" disabled={busy || !title.trim()}>Add idea</button>
        <button class="secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p class="hint">Your idea will be visible to everyone. It is not labeled with your name.</p>
    </form>
  );
}
