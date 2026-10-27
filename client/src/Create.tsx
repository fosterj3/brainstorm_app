import { useEffect, useState } from "preact/hooks";
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
const MIN_OPTIONS = 2;
const FEATURED_TEMPLATES = 3;
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

/** The viewer's time zone in words, such as "Eastern Daylight Time", so a closing time is never ambiguous. */
function zoneName(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** A link like /create?template=survey-actions or /create?method=rank starts the form already filled in. */
function startFromLink() {
  const params = new URLSearchParams(location.search);
  const template = templateById(params.get("template") ?? "") ?? null;
  const asked = params.get("method");
  const method = METHODS.find((m) => m.id === asked)?.id;
  return { template, method };
}

interface Problems {
  title?: string;
  options?: string;
  closes?: string;
}

/** A numbered step heading. The number is decoration; the heading text carries the meaning. */
function StepTitle({ n, id, children }: { n: number; id: string; children: string }) {
  return (
    <h3 class="step-title" id={id}>
      <span class="step-num" aria-hidden="true">{n}</span>
      {children}
    </h3>
  );
}

/**
 * The create screen. The basics fit on one screen and take under a minute, in four numbered steps: name it, add the
 * choices, say how people will vote, and press Create. Everything else is under "More options" and has a sensible default.
 */
export function CreateForm() {
  const [start] = useState(startFromLink);
  const t0 = start.template;
  const [templateId, setTemplateId] = useState(t0?.id ?? "blank");
  const [showAllTemplates, setShowAllTemplates] = useState(() => !!t0 && TEMPLATES.indexOf(t0) >= FEATURED_TEMPLATES);
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
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const zone = zoneName();

  // Put the cursor in the first empty field, so a new organizer can just start typing.
  useEffect(() => {
    if (!t0) document.getElementById("c-title")?.focus();
  }, []);

  const clear = (key: keyof Problems) => setProblems((p) => (p[key] ? { ...p, [key]: undefined } : p));

  const pick = (t: Template | null) => {
    if (touched && !confirm("Replace what you have typed with this template?")) return;
    setTemplateId(t?.id ?? "blank");
    setTouched(false);
    setError("");
    setProblems({});
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
    clear("options");
  };
  const addPasted = () => {
    const list = onlyNew(options.map((o) => o.title), parseList(paste)).slice(0, Math.max(0, MAX_OPTIONS - options.length));
    if (list.length === 0) return;
    setOptions([...options, ...list.map((t) => ({ key: ++keySeed, title: t }))]);
    setPaste("");
    setTouched(true);
    clear("options");
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
  const optionCount = options.filter((o) => o.title.trim()).length;

  /** When an open poll closes, or null for never. Returns undefined if the picked date is not usable. */
  const deadline = (): number | null | undefined => {
    if (closes === "none") return null;
    if (closes === "custom") return fromLocalInput(customCloses) ?? undefined;
    return Date.now() + Number(closes) * DAY;
  };
  const when = deadline();
  const chosen = METHODS.find((m) => m.id === method)!;
  const methodLabel = chosen.label.toLowerCase();
  const howTheyChoose = method === "dots" ? `Everyone gets ${votes} ${votes === 1 ? "vote" : "votes"} to spend on their favorites.` : chosen.blurb;
  const summary =
    mode === "poll"
      ? `Open poll, ${methodLabel}. ${when === null ? "It stays open until you close it." : when === undefined ? "Pick a closing time." : `It closes ${formatWhen(when)}.`}`
      : `Live session, ${methodLabel}. You start and stop the voting.`;

  /** Show what is wrong next to the field and put the cursor there. */
  const fail = (found: Problems, focusId: string) => {
    setProblems(found);
    setError("");
    document.getElementById(focusId)?.focus();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const list = options.map((o) => ({ ...o, title: o.title.trim() })).filter((o) => o.title);
    if (!title.trim()) return fail({ title: "Give your poll a title so people know what they are voting on." }, "c-title");
    if (mode === "poll" && list.length < MIN_OPTIONS) {
      return fail({ options: `Add at least ${MIN_OPTIONS} options for people to choose between. You have ${list.length}.` }, "c-add");
    }
    const closing = deadline();
    if (mode === "poll" && closing === undefined) return fail({ closes: "Pick a date and time for the poll to close." }, "c-closes");
    if (mode === "poll" && closing !== null && closing! <= Date.now()) return fail({ closes: "Choose a closing time in the future." }, "c-closes");
    setBusy(true);
    setError("");
    setProblems({});
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
      api.markJustCreated(r.id);
      location.assign(`/f/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const visibleTemplates = showAllTemplates ? TEMPLATES : TEMPLATES.slice(0, FEATURED_TEMPLATES);

  return (
    <section class="panel create" aria-labelledby="h-create">
      <h2 id="h-create">Create a poll</h2>
      <p class="hint">Four quick steps. No account needed.</p>
      <form onSubmit={submit} noValidate>
        <fieldset class="field">
          <legend>Want a head start? Pick a template (optional)</legend>
          <div class="templates" role="radiogroup" aria-label="Start from a template">
            <button type="button" role="radio" aria-checked={templateId === "blank"} class={`tpl${templateId === "blank" ? " on" : ""}`} onClick={() => pick(null)}>
              <strong>Start blank</strong>
              <span class="hint">Write your own</span>
            </button>
            {visibleTemplates.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} class={`tpl${templateId === t.id ? " on" : ""}`} onClick={() => pick(t)}>
                <strong>{t.name}</strong>
                <span class="hint">{t.blurb}</span>
              </button>
            ))}
          </div>
          {TEMPLATES.length > FEATURED_TEMPLATES && (
            <button type="button" class="link-button" aria-expanded={showAllTemplates} onClick={() => setShowAllTemplates(!showAllTemplates)}>
              {showAllTemplates ? "Show fewer templates" : `See all ${TEMPLATES.length} templates`}
            </button>
          )}
        </fieldset>

        <section class="create-step" aria-labelledby="s-name">
          <StepTitle n={1} id="s-name">Name it</StepTitle>
          <div class="field">
            <label for="c-title">Poll title</label>
            <input
              id="c-title" value={title} maxLength={100} placeholder="e.g. Team priorities for next quarter"
              aria-invalid={problems.title ? "true" : undefined} aria-describedby={problems.title ? "e-title" : undefined}
              onInput={(e) => { setTitle((e.target as HTMLInputElement).value); setTouched(true); clear("title"); }}
            />
            {problems.title && <p class="field-error" id="e-title" role="alert">{problems.title}</p>}
          </div>
          <div class="field">
            <label for="c-sub">Instructions for voters (optional)</label>
            <input id="c-sub" value={prompt} maxLength={200} placeholder="e.g. Pick the three you think matter most" onInput={(e) => { setPrompt((e.target as HTMLInputElement).value); setTouched(true); }} />
          </div>
        </section>

        <section class="create-step" aria-labelledby="s-choices">
          <StepTitle n={2} id="s-choices">Add the choices</StepTitle>
          <div class="field">
            <label for="c-add">Options people will choose between</label>
            <p class="hint">Type one and press Enter, or paste a whole list.</p>
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
                aria-invalid={problems.options ? "true" : undefined} aria-describedby={problems.options ? "e-options" : undefined}
                onInput={(e) => setAdding((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
              />
              <button type="button" class="secondary" disabled={!adding.trim()} onClick={addOne}>Add</button>
            </div>
            <p class={`count-line${mode === "poll" && optionCount < MIN_OPTIONS ? " need" : ""}`} role="status" aria-live="polite">
              {optionCount} {optionCount === 1 ? "option" : "options"} added
              {mode === "poll" && optionCount < MIN_OPTIONS && `. You need at least ${MIN_OPTIONS}.`}
              {mode === "live" && optionCount === 0 && ". You can add them later, or let participants add their own."}
            </p>
            {problems.options && <p class="field-error" id="e-options" role="alert">{problems.options}</p>}
            <details class="more paste">
              <summary>Paste a list</summary>
              <label for="c-paste" class="sr-only">Paste options, one per line</label>
              <textarea id="c-paste" rows={5} value={paste} placeholder={"One option per line\nPizza\nSushi\nTacos"} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
              <button type="button" class="secondary" disabled={fresh.length === 0} onClick={addPasted}>
                Add {fresh.length || ""} {fresh.length === 1 ? "option" : "options"} from this list
              </button>
            </details>
          </div>
        </section>

        <section class="create-step" aria-labelledby="s-how">
          <StepTitle n={3} id="s-how">Choose how people vote</StepTitle>
          <fieldset class="field">
            <legend>Will people vote on their own time, or all together in a meeting?</legend>
            <label class="method-option">
              <input type="radio" name="c-mode" checked={mode === "poll"} onChange={() => setMode("poll")} />
              <span><strong>On their own time</strong><span class="hint">An open poll. You share a link and people vote whenever they like before it closes. Best for groups in different places or time zones.</span></span>
            </label>
            <label class="method-option">
              <input type="radio" name="c-mode" checked={mode === "live"} onChange={() => setMode("live")} />
              <span><strong>All together, in a meeting</strong><span class="hint">A live session. Everyone votes at the same time while you run it, with an optional timer.</span></span>
            </label>
          </fieldset>

          {mode === "poll" && (
            <div class="field">
              <label for="c-closes">When should voting end?</label>
              <select id="c-closes" value={closes} aria-invalid={problems.closes ? "true" : undefined} aria-describedby={problems.closes ? "e-closes" : undefined}
                onChange={(e) => { setCloses((e.target as HTMLSelectElement).value); clear("closes"); }}>
                {CLOSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {closes === "custom" && (
                <input type="datetime-local" aria-label={`Closing date and time${zone ? `, in ${zone}` : ""}`} value={customCloses} onInput={(e) => { setCustomCloses((e.target as HTMLInputElement).value); clear("closes"); }} />
              )}
              {problems.closes && <p class="field-error" id="e-closes" role="alert">{problems.closes}</p>}
              <span class="hint">
                {zone ? `Times are in your time zone (${zone}). ` : "Times are in your time zone. "}
                People in other places see the time in theirs. When it closes, the results appear for you right away.
              </span>
            </div>
          )}

          <div class="field">
            <span class="field-label">How people choose</span>
            <p class="how-line"><strong>{chosen.label}.</strong> {howTheyChoose}</p>
            <details class="more">
              <summary>Change how people choose</summary>
              <fieldset class="field">
                <legend class="sr-only">How people choose</legend>
                {METHODS.map((m) => (
                  <label class="method-option" key={m.id}>
                    <input type="radio" name="c-method" checked={method === m.id} onChange={() => setMethod(m.id)} />
                    <span><strong>{m.label}</strong><span class="hint">{m.blurb}</span></span>
                  </label>
                ))}
              </fieldset>
              {method === "dots" && (
                <div class="field">
                  <label for="c-votes">How many votes does each person get?</label>
                  <input id="c-votes" type="number" min="1" max="20" value={votes} onChange={(e) => setVotes(Math.max(1, Math.min(20, Math.floor(Number((e.target as HTMLInputElement).value)) || 1)))} />
                </div>
              )}
            </details>
          </div>

          <details class="more">
            <summary>More options</summary>
            <fieldset class="field">
              <legend>Should you see who picked what?</legend>
              <label class="inline"><input type="radio" name="c-named" checked={!named} onChange={() => setNamed(false)} /> No, keep votes anonymous (recommended)</label>
              <label class="inline"><input type="radio" name="c-named" checked={named} onChange={() => setNamed(true)} /> Yes, show me who voted for what (only you will see it)</label>
              <span class="hint">Anonymous means you only ever see totals. Choose Yes only if people need to be accountable for their picks.</span>
            </fieldset>
            {mode === "poll" && (
              <label class="inline">
                <input type="checkbox" checked={shareResults} onChange={(e) => setShareResults((e.target as HTMLInputElement).checked)} />
                Show everyone the results when voting ends (always anonymous)
              </label>
            )}
            {mode === "live" && (
              <label class="inline">
                <input type="checkbox" checked={allowAdd} onChange={(e) => setAllowAdd((e.target as HTMLInputElement).checked)} />
                Let participants add their own options before voting starts
              </label>
            )}
            <p class="hint">After you create the poll you can also add groups, longer details for each option, and change these settings.</p>
          </details>
        </section>

        <section class="create-step" aria-labelledby="s-create">
          <StepTitle n={4} id="s-create">Create it</StepTitle>
          <p class="summary-line" role="status" aria-live="polite">{summary}</p>
          {error && <p role="alert" class="error">{error}</p>}
          <button class="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create poll"}</button>
          <p class="hint">You will get a link to share with participants and a private organizer link for you.</p>
        </section>
      </form>
    </section>
  );
}
