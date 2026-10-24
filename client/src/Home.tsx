import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import { homeTour, Tour, TourButton, useTour } from "./Help";

/** Pull a session code out of whatever the person pasted: a code, or a full participant link. */
export function extractCode(input: string): string {
  const text = input.trim();
  const fromLink = text.match(/\/s\/([A-Za-z0-9]+)/);
  return (fromLink ? fromLink[1] : text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function Home() {
  const boards = api.myBoards();
  const tour = useTour("home");
  return (
    <main class="page home">
      {tour.open && <Tour title="Quick tour" steps={homeTour} onClose={tour.close} />}
      <header class="hero">
        <h1>Silent prioritization, together</h1>
        <p class="lead">
          Build a board of ideas, send one link to your group, and see what they star. Everyone votes privately and at the same time,
          so the loudest voice does not decide.
        </p>
        <TourButton onClick={tour.start} />
      </header>

      <div class="home-grid">
        <CreateForm />
        <div>
          <JoinForm />
          <RestoreForm />
          {boards.length > 0 && <MyBoards initial={boards} />}
          <JoinedSessions />
          <p class="hint">Your lists are saved in this browser only. Keep your private facilitator links to get back in from another device.</p>
        </div>
      </div>
    </main>
  );
}

function CreateForm() {
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [template, setTemplate] = useState<"blank" | "example">("blank");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.createBoard({ title, subtitle, template });
      api.setAdminKey(r.id, r.adminKey);
      api.rememberBoard(r.id, title.trim());
      location.assign(`/f/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section class="panel" aria-labelledby="h-create">
      <h2 id="h-create">Facilitate a session</h2>
      <form onSubmit={submit}>
        <label for="c-title">Session title</label>
        <input id="c-title" value={title} maxLength={100} required placeholder="e.g. Leadership offsite priorities" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        <label for="c-sub">What are people choosing between? (optional)</label>
        <input id="c-sub" value={subtitle} maxLength={200} onInput={(e) => setSubtitle((e.target as HTMLInputElement).value)} />
        <fieldset class="field">
          <legend>Start from</legend>
          <label class="inline"><input type="radio" name="tpl" checked={template === "blank"} onChange={() => setTemplate("blank")} /> A blank board</label>
          <label class="inline"><input type="radio" name="tpl" checked={template === "example"} onChange={() => setTemplate("example")} /> An example board to edit</label>
        </fieldset>
        {error && <p role="alert" class="error">{error}</p>}
        <button class="primary" type="submit" disabled={busy || !title.trim()}>Create board</button>
      </form>
      <p class="hint">No account needed. You get a private facilitator link and a separate link to share with participants.</p>
    </section>
  );
}

function JoinForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    const code = extractCode(value);
    if (!code) return;
    setBusy(true);
    setError("");
    try {
      await api.boardExists(code);
      location.assign(`/s/${code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section class="panel" aria-labelledby="h-join">
      <h2 id="h-join">Join a session</h2>
      <form onSubmit={submit}>
        <label for="j-code">Session code or link</label>
        <input id="j-code" value={value} autocomplete="off" aria-invalid={error ? "true" : undefined} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        {error && <p role="alert" class="error">{error}</p>}
        <button class="secondary" type="submit" disabled={busy || !extractCode(value)}>Join</button>
      </form>
    </section>
  );
}

const PHASE_LABEL: Record<string, string> = {
  setup: "Setting up",
  voting: "Voting open",
  locked: "Voting locked",
  revealed: "Results showing",
};

const daysAgo = (ms: number) => {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

type Status = { state: "loading" } | { state: "ok"; s: api.BoardSummary } | { state: "gone" };

/** Boards this browser can facilitate: status at a glance, open again, or delete. */
function MyBoards({ initial }: { initial: { id: string; title: string }[] }) {
  const [boards, setBoards] = useState(initial);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    for (const b of initial) {
      api.adminSummary(b.id)
        .then((s) => setStatus((m) => ({ ...m, [b.id]: { state: "ok", s } })))
        .catch((e: api.ApiError) =>
          setStatus((m) => ({ ...m, [b.id]: e.code === "unauthorized" || e.code === "unknown_session" ? { state: "gone" } : { state: "loading" } })));
    }
  }, []);

  const forget = (id: string) => {
    api.forgetAdminKey(id);
    setBoards((list) => list.filter((b) => b.id !== id));
  };

  const remove = async (b: { id: string; title: string }) => {
    if (!confirm(`Delete "${b.title}" for good? Its ideas, participants and votes will be erased and its links will stop working. This cannot be undone.`)) return;
    setError("");
    try {
      await api.adminDeleteBoard(b.id);
      forget(b.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = (id: string) => navigator.clipboard?.writeText(`${location.origin}/s/${id}`).catch(() => {});

  return (
    <section class="panel" aria-labelledby="h-mine">
      <h2 id="h-mine">Your boards</h2>
      {boards.length === 0 && <p class="empty">No boards on this device.</p>}
      <ul class="board-list">
        {boards.map((b) => {
          const st = status[b.id] ?? { state: "loading" };
          return (
            <li key={b.id} class="board-item">
              <div class="board-main">
                <strong>{b.title}</strong> <span class="hint">({b.id})</span>
                {st.state === "ok" && (
                  <div class="hint">
                    {PHASE_LABEL[st.s.phase] ?? st.s.phase} · {st.s.ideas} ideas · {st.s.joined} joined, {st.s.submitted} submitted · last used {daysAgo(st.s.lastActive)}
                  </div>
                )}
                {st.state === "gone" && <div class="hint">This board no longer exists on the server (boards are removed when the hosting restarts or after 90 days unused).</div>}
              </div>
              <div class="row wrap actions">
                {st.state === "gone" ? (
                  <button class="secondary" onClick={() => forget(b.id)}>Remove from list</button>
                ) : (
                  <>
                    <a class="button-link primary" href={`/f/${b.id}`}>Open</a>
                    <button class="secondary" onClick={() => copy(b.id)} aria-label={`Copy participant link for ${b.title}`}>Copy link</button>
                    <button class="danger" onClick={() => remove(b)} aria-label={`Delete ${b.title}`}>Delete</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" class="error">{error}</p>}
      <p class="hint">Boards nobody has used for 90 days are deleted automatically.</p>
    </section>
  );
}

/** Sessions this browser has joined as a participant, so people can get back to them. */
function JoinedSessions() {
  const [list, setList] = useState(api.joinedSessions());
  const [gone, setGone] = useState<Set<string>>(new Set());

  useEffect(() => {
    for (const j of list) api.boardExists(j.id).catch(() => setGone((g) => new Set(g).add(j.id)));
  }, []);

  if (list.length === 0) return null;
  const forget = (id: string) => {
    api.forgetJoined(id);
    setList((l) => l.filter((x) => x.id !== id));
  };
  return (
    <section class="panel" aria-labelledby="h-joined">
      <h2 id="h-joined">Sessions you have joined</h2>
      <ul class="board-list">
        {list.map((j) => (
          <li key={j.id} class="board-item">
            <div class="board-main">
              <strong>{j.title}</strong> <span class="hint">({j.id})</span>
              {gone.has(j.id) && <div class="hint">This session has ended.</div>}
            </div>
            <div class="row wrap actions">
              {!gone.has(j.id) && <a class="button-link primary" href={`/s/${j.id}`}>Open</a>}
              <button class="secondary" onClick={() => forget(j.id)} aria-label={`Remove ${j.title} from this list`}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Rebuild a board from a results CSV that was downloaded earlier. Hosting can erase boards, so this is the way back. */
function RestoreForm() {
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!title.trim()) {
      setError("Give the restored board a title first.");
      input.value = "";
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api.restoreResults(title, await file.text());
      api.setAdminKey(r.id, r.adminKey);
      api.rememberBoard(r.id, title.trim());
      sessionStorage.setItem("brainstorm.openResults", r.id);
      location.assign(`/f/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      input.value = "";
    }
  };

  return (
    <section class="panel" aria-labelledby="h-restore">
      <h2 id="h-restore">Restore results from a CSV</h2>
      <p class="hint">Lost a board? Upload the results CSV you downloaded and the ranking comes back as a new board.</p>
      <div class="field">
        <label for="r-title">Title for the restored board</label>
        <input id="r-title" value={title} maxLength={100} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label for="r-file">Results CSV</label>
        <input id="r-file" type="file" accept=".csv,text/csv" disabled={busy} onChange={onFile} aria-describedby={error ? "r-error" : undefined} />
      </div>
      {error && <p id="r-error" role="alert" class="error">{error}</p>}
    </section>
  );
}
