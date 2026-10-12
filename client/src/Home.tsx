import { useState } from "preact/hooks";
import * as api from "./api";

/** Pull a session code out of whatever the person pasted: a code, or a full participant link. */
export function extractCode(input: string): string {
  const text = input.trim();
  const fromLink = text.match(/\/s\/([A-Za-z0-9]+)/);
  return (fromLink ? fromLink[1] : text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function Home() {
  const boards = api.myBoards();
  return (
    <main class="page home">
      <header class="hero">
        <h1>Silent prioritization, together</h1>
        <p class="lead">
          Build a board of ideas, send one link to your group, and see what they star. Everyone votes privately and at the same time,
          so the loudest voice does not decide.
        </p>
      </header>

      <div class="home-grid">
        <CreateForm />
        <div>
          <JoinForm />
          {boards.length > 0 && (
            <section class="panel" aria-labelledby="h-mine">
              <h2 id="h-mine">Your boards on this device</h2>
              <ul class="plain">
                {boards.map((b) => (
                  <li key={b.id}>
                    <a href={`/f/${b.id}`}>{b.title}</a> <span class="hint">({b.id})</span>
                  </li>
                ))}
              </ul>
              <p class="hint">Facilitator access is saved in this browser only. Keep your private facilitator link to return from another device.</p>
            </section>
          )}
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
