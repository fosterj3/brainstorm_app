import { useState } from "preact/hooks";
import * as api from "./api";
import type { Method, Mode } from "./api";
import { TEMPLATES, templateById, type Template, type TemplateGroup } from "../../shared/templates";
import { METHODS } from "./methods";
import { formatWhen, fromLocalInput, onlyNew, parseList, toLocalInput } from "./time";

/** One option on the create screen. Template options keep their group, tag and details even though only the title is edited here. */
interface Opt {
  key: number;
  title: string;
  summary?: string;
  details?: string;
  group?: string;
  tag?: string;
  code?: string;
}
let keySeed = 0;
const MAX_OPTIONS = 300;
const DAY = 24 * 60 * 60 * 1000;

const CLOSES: { value: string; label: string }[] = [
  { value: "1", label: "In 1 day" },
  { value: "2", label: "In 2 days" },
  { value: "3", label: "In 3 days" },
  { value: "7", label: "In 1 week" },
  { value: "14", label: "In 2 weeks" },
  { value: "none", label: "Never (I will close it myself)" },
  { value: "custom", label: "Pick a date and time" },
];
const closesFor = (days: number) => (["1", "2", "3", "7", "14"].includes(String(days)) ? String(days) : "7");
const optsFrom = (t: Template): Opt[] => t.options.map((o) => ({ key: ++keySeed, ...o }));

/** A link like /create?template=survey-actions or /create?method=rank starts the form already filled in. */
function startFromLink() {
  const params = new URLSearchParams(location.search);
  const template = templateById(params.get("template") ?? "") ?? null;
  const asked = params.get("method");
  const method = METHODS.find((m) => m.id === asked)?.id;
  return { template, method };
}

/**
 * The create screen. The basics fit on one screen and take under a minute: pick a template (or start blank), set
 * the title, list the options (one at a time, or paste a list), and press Create. Everything else is under
 * "More options" and has a sensible default.
 */
export function CreateForm() {
  const [start] = useState(startFromLink);
  const t0 = start.template;
  const [templateId, setTemplateId] = useState(t0?.id ?? "blank");
  const [title, setTitle] = useState(t0?.title ?? "");
  const [prompt, setPrompt] = useState(t0?.prompt ?? "");
  const [options, setOptions] = useState<Opt[]>(() => (t0 ? optsFrom(t0) : []));
  const [groups, setGroups] = useState<TemplateGroup[]>(t0?.groups ?? []);
  const [touched, setTouched] = useState(false); // typed something of their own, so a template should ask before replacing it
  const [adding, setAdding] = useState("");
  const [paste, setPaste] = useState("");
  const [method, setMethod] = useState<Method>(start.method ?? t0?.method ?? "dots");
  const [mode, setMode] = useState<Mode>("poll");
  const [closes, setCloses] = useState(t0 ? closesFor(t0.closesInDays) : "7");
  const [customCloses, setCustomCloses] = useState(() => toLocalInput(Date.now() + 7 * DAY));
  const [votes, setVotes] = useState(t0?.votesPerPerson ?? 3);
  const [named, setNamed] = useState(false);
  const [allowAdd, setAllowAdd] = useState(true);
  const [shareResults, setShareResults] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = (t: Template | null) => {
    if (touched && !confirm("Replace what you have typed with this template?")) return;
    setTemplateId(t?.id ?? "blank");
    setTouched(false);
    setError("");
    if (!t) {
      setTitle("");
      setPrompt("");
      setOptions([]);
      setGroups([]);
      setMethod("dots");
      setVotes(3);
      setCloses("7");
      return;
    }
    setTitle(t.title);
    setPrompt(t.prompt);
    setOptions(optsFrom(t));
    setGroups(t.groups ?? []);
    setMethod(t.method);
    setVotes(t.votesPerPerson ?? 3);
    setCloses(closesFor(t.closesInDays));
  };

  const addOne = () => {
    const text = adding.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!text) return;
    if (options.length >= MAX_OPTIONS) return setError(`A poll can have at most ${MAX_OPTIONS} options.`);
    setOptions([...options, { key: ++keySeed, title: text }]);
    setAdding("");
    setTouched(true);
  };
  const addPasted = () => {
    const list = onlyNew(options.map((o) => o.title), parseList(paste)).slice(0, Math.max(0, MAX_OPTIONS - options.length));
    if (list.length === 0) return;
    setOptions([...options, ...list.map((t) => ({ key: ++keySeed, title: t }))]);
    setPaste("");
    setTouched(true);
  };
  const edit = (key: number, value: string) => {
    setOptions(options.map((o) => (o.key === key ? { ...o, title: value } : o)));
    setTouched(true);
  };
  const remove = (key: number) => {
    setOptions(options.filter((o) => o.key !== key));
    setTouched(true);
  };

  const fresh = onlyNew(options.map((o) => o.title), parseList(paste));

  /** When an open poll closes, or null for never. Returns undefined if the picked date is not usable. */
  const deadline = (): number | null | undefined => {
    if (closes === "none") return null;
    if (closes === "custom") return fromLocalInput(customCloses) ?? undefined;
    return Date.now() + Number(closes) * DAY;
  };
  const when = deadline();
  const methodLabel = METHODS.find((m) => m.id === method)!.label.toLowerCase();
  const summary =
    mode === "poll"
      ? `Open poll, ${methodLabel}. ${when === null ? "It stays open until you close it." : when === undefined ? "Pick a closing time." : `It closes ${formatWhen(when)}.`}`
      : `Live session, ${methodLabel}. You start and stop the voting.`;

  const submit = async (e: Event) => {
    e.preventDefault();
    const list = options.map((o) => ({ ...o, title: o.title.trim() })).filter((o) => o.title);
    if (!title.trim()) return setError("Give your poll a title.");
    if (mode === "poll" && list.length < 2) return setError("Add at least two options for people to choose between.");
    const closing = deadline();
    if (mode === "poll" && closing === undefined) return setError("Pick a date and time for the poll to close.");
    if (mode === "poll" && closing !== null && closing! <= Date.now()) return setError("Choose a closing time in the future.");
    setBusy(true);
    setError("");
    try {
      const used = new Set(list.map((o) => o.group).filter(Boolean));
      const r = await api.createBoard({
        title: title.trim(),
        subtitle: prompt.trim(),
        method,
        mode,
        deadline: mode === "poll" && closing !== null ? closing : undefined,
        options: list.map(({ key: _k, ...o }) => o),
        groups: groups.filter((g) => used.has(g.name)),
        settings: {
          votesPerPerson: method === "dots" ? votes : undefined,
          namedResults: named,
          ideasOpen: mode === "live" ? allowAdd : undefined,
          shareResults: mode === "poll" ? shareResults : undefined,
        },
      });
      api.setAdminKey(r.id, r.adminKey);
      api.rememberBoard(r.id, title.trim());
      location.assign(`/f/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section class="panel create" aria-labelledby="h-create">
      <h2 id="h-create">Create a poll</h2>
      <form onSubmit={submit}>
        <fieldset class="field">
          <legend>Start from a template</legend>
          <div class="templates" role="radiogroup" aria-label="Start from a template">
            <button type="button" role="radio" aria-checked={templateId === "blank"} class={`tpl${templateId === "blank" ? " on" : ""}`} onClick={() => pick(null)}>
              <strong>Start blank</strong>
              <span class="hint">Write your own</span>
            </button>
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} class={`tpl${templateId === t.id ? " on" : ""}`} onClick={() => pick(t)}>
                <strong>{t.name}</strong>
                <span class="hint">{t.blurb}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div class="field">
          <label for="c-title">Poll title</label>
          <input id="c-title" value={title} maxLength={100} required placeholder="e.g. Team priorities for next quarter" onInput={(e) => { setTitle((e.target as HTMLInputElement).value); setTouched(true); }} />
        </div>
        <div class="field">
          <label for="c-sub">What are people deciding? (optional)</label>
          <input id="c-sub" value={prompt} maxLength={200} onInput={(e) => { setPrompt((e.target as HTMLInputElement).value); setTouched(true); }} />
        </div>

        <div class="field">
          <label for="c-add">Options</label>
          <p class="hint">Add the choices people will vote on, one at a time. You can also paste a list.</p>
          {options.length > 0 && (
            <ol class="option-list">
              {options.map((o, i) => (
                <li key={o.key}>
                  <input aria-label={`Option ${i + 1}`} value={o.title} maxLength={120} onInput={(e) => edit(o.key, (e.target as HTMLInputElement).value)} />
                  <button type="button" class="step" aria-label={`Remove option ${i + 1}: ${o.title}`} onClick={() => remove(o.key)}>×</button>
                </li>
              ))}
            </ol>
          )}
          <div class="row">
            <input
              id="c-add" value={adding} maxLength={120} placeholder={options.length === 0 ? "Type your first option" : "Add another option"}
              onInput={(e) => setAdding((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
            />
            <button type="button" class="secondary" disabled={!adding.trim()} onClick={addOne}>Add</button>
          </div>
          <details class="more paste">
            <summary>Paste a list</summary>
            <label for="c-paste" class="sr-only">Paste options, one per line</label>
            <textarea id="c-paste" rows={5} value={paste} placeholder={"One option per line\nPizza\nSushi\nTacos"} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
            <button type="button" class="secondary" disabled={fresh.length === 0} onClick={addPasted}>
              Add {fresh.length || ""} {fresh.length === 1 ? "option" : "options"} from this list
            </button>
          </details>
        </div>

        <p class="summary-line" role="status" aria-live="polite">{summary}</p>

        <details class="more">
          <summary>More options</summary>
          <fieldset class="field">
            <legend>How people vote</legend>
            {METHODS.map((m) => (
              <label class="method-option" key={m.id}>
                <input type="radio" name="c-method" checked={method === m.id} onChange={() => setMethod(m.id)} />
                <span><strong>{m.label}</strong><span class="hint">{m.blurb}</span></span>
              </label>
            ))}
          </fieldset>
          {method === "dots" && (
            <div class="field">
              <label for="c-votes">Votes per person</label>
              <input id="c-votes" type="number" min="1" max="20" value={votes} onChange={(e) => setVotes(Math.max(1, Math.min(20, Math.floor(Number((e.target as HTMLInputElement).value)) || 1)))} />
            </div>
          )}
          <fieldset class="field">
            <legend>How will it run?</legend>
            <label class="method-option">
              <input type="radio" name="c-mode" checked={mode === "poll"} onChange={() => setMode("poll")} />
              <span><strong>Open poll</strong><span class="hint">People vote any time before it closes. Best for groups in different places or time zones.</span></span>
            </label>
            <label class="method-option">
              <input type="radio" name="c-mode" checked={mode === "live"} onChange={() => setMode("live")} />
              <span><strong>Live session</strong><span class="hint">Everyone votes together while you run it, with an optional timer.</span></span>
            </label>
          </fieldset>
          {mode === "poll" && (
            <>
              <div class="field">
                <label for="c-closes">It closes</label>
                <select id="c-closes" value={closes} onChange={(e) => setCloses((e.target as HTMLSelectElement).value)}>
                  {CLOSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                {closes === "custom" && (
                  <input type="datetime-local" aria-label="Closing date and time" value={customCloses} onInput={(e) => setCustomCloses((e.target as HTMLInputElement).value)} />
                )}
                <span class="hint">Shown in your time zone. When it closes, the results appear for you right away.</span>
              </div>
              <label class="inline">
                <input type="checkbox" checked={shareResults} onChange={(e) => setShareResults((e.target as HTMLInputElement).checked)} />
                Let participants see the results after it closes (always anonymous)
              </label>
            </>
          )}
          {mode === "live" && (
            <label class="inline">
              <input type="checkbox" checked={allowAdd} onChange={(e) => setAllowAdd((e.target as HTMLInputElement).checked)} />
              Let participants add their own options before voting starts
            </label>
          )}
          <fieldset class="field">
            <legend>Results show</legend>
            <label class="inline"><input type="radio" name="c-named" checked={!named} onChange={() => setNamed(false)} /> Anonymous totals</label>
            <label class="inline"><input type="radio" name="c-named" checked={named} onChange={() => setNamed(true)} /> Who voted for what (organizer only)</label>
          </fieldset>
          <p class="hint">After you create the poll you can also add groups, longer details for each option, and change these settings.</p>
        </details>

        {error && <p role="alert" class="error">{error}</p>}
        <button class="primary" type="submit" disabled={busy}>Create poll</button>
      </form>
      <p class="hint">No account needed. You get a private organizer link and a separate link to share with participants.</p>
    </section>
  );
}
