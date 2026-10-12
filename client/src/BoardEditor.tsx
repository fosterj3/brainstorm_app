import { useState } from "preact/hooks";
import * as api from "./api";
import type { Column, FacilitatorIdea, FacilitatorState } from "./api";
import { BACKGROUNDS, ColorPicker } from "./ColorPicker";

let uidCounter = 0;
export type Run = (fn: () => Promise<unknown>) => Promise<void>;

const textInput = (set: (v: string) => void) => (e: Event) => set((e.target as HTMLInputElement).value);

/** Everything about building the board: its look, its columns, its ideas, and import/export. */
export function BoardEditor({ sid, state, run }: { sid: string; state: FacilitatorState; run: Run }) {
  return (
    <>
      <LookPanel sid={sid} state={state} run={run} />
      <ColumnsPanel sid={sid} state={state} run={run} />
      <ImportPanel sid={sid} phase={state.settings.phase} run={run} />
    </>
  );
}

function LookPanel({ sid, state, run }: { sid: string; state: FacilitatorState; run: Run }) {
  const { board } = state;
  const [title, setTitle] = useState(board.title);
  const [subtitle, setSubtitle] = useState(board.subtitle);
  return (
    <section class="panel" aria-labelledby="h-look">
      <h2 id="h-look">Board title and look</h2>
      <div class="grid">
        <div class="field">
          <label for="b-title">Title</label>
          <input id="b-title" value={title} maxLength={100} onInput={textInput(setTitle)} onChange={() => title.trim() && run(() => api.adminBoard(sid, { title }))} />
        </div>
        <div class="field">
          <label for="b-sub">Subtitle (what people are choosing between)</label>
          <input id="b-sub" value={subtitle} maxLength={200} onInput={textInput(setSubtitle)} onChange={() => run(() => api.adminBoard(sid, { subtitle }))} />
        </div>
      </div>
      <ColorPicker label="Page background" value={board.bg} options={BACKGROUNDS} onChange={(bg) => run(() => api.adminBoard(sid, { bg }))} />
    </section>
  );
}

function ColumnsPanel({ sid, state, run }: { sid: string; state: FacilitatorState; run: Run }) {
  const normal = state.columns.filter((c) => c.kind === "normal");
  const group = state.columns.find((c) => c.kind === "group");
  const [name, setName] = useState("");

  return (
    <section class="panel" aria-labelledby="h-cols">
      <h2 id="h-cols">Columns and ideas</h2>
      <p class="hint">Each column groups related ideas and has its own color. Participants see columns side by side.</p>

      {normal.map((col, i) => (
        <ColumnEditor key={col.id} sid={sid} col={col} first={i === 0} last={i === normal.length - 1} state={state} run={run} />
      ))}

      <form class="inline-form" aria-label="Add a column" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.adminAddColumn(sid, { name }); setName(""); }); }}>
        <input aria-label="New column name" placeholder="New column name" value={name} maxLength={60} required onInput={textInput(setName)} />
        <button class="primary" type="submit" disabled={!name.trim()}>Add column</button>
      </form>

      {group && (
        <>
          <h3 class="subhead">Group column</h3>
          <p class="hint">Where participants' own ideas appear. You can rename or recolor it, but not delete it.</p>
          <ColumnEditor sid={sid} col={group} first last state={state} run={run} />
        </>
      )}
    </section>
  );
}

function ColumnEditor(props: { sid: string; col: Column; first: boolean; last: boolean; state: FacilitatorState; run: Run }) {
  const { sid, col, state, run } = props;
  const [name, setName] = useState(col.name);
  const [desc, setDesc] = useState(col.description);
  const ideas = state.ideas.filter((i) => i.columnId === col.id);
  const isGroup = col.kind === "group";
  const save = (patch: api.ColumnInput) => run(() => api.adminEditColumn(sid, col.id, patch));

  return (
    <div class="col-editor" style={{ "--c": col.color }}>
      <div class="col-head">
        <span class="dot" aria-hidden="true" />
        <div class="col-fields">
          <label class="sr-only" for={`cn-${col.id}`}>Column name</label>
          <input id={`cn-${col.id}`} value={name} maxLength={60} onInput={textInput(setName)} onChange={() => name.trim() && save({ name })} />
          <label class="sr-only" for={`cd-${col.id}`}>Column description</label>
          <input id={`cd-${col.id}`} placeholder="Short description (optional)" value={desc} maxLength={200} onInput={textInput(setDesc)} onChange={() => save({ description: desc })} />
        </div>
        {!isGroup && (
          <div class="row actions">
            <button class="secondary" disabled={props.first} aria-label={`Move ${col.name} left`} onClick={() => run(() => api.adminMoveColumn(sid, col.id, "left"))}>←</button>
            <button class="secondary" disabled={props.last} aria-label={`Move ${col.name} right`} onClick={() => run(() => api.adminMoveColumn(sid, col.id, "right"))}>→</button>
            <button
              class="danger" aria-label={`Delete column ${col.name}`}
              onClick={() => confirm(`Delete the column "${col.name}" and its ${ideas.length} ${ideas.length === 1 ? "idea" : "ideas"}? Any stars on them go back to the people who used them.`) && run(() => api.adminDeleteColumn(sid, col.id))}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <ColorPicker label={`Color for ${col.name}`} value={col.color} onChange={(color) => save({ color })} />

      <ul class="idea-list">
        {ideas.map((i) => <IdeaRow key={i.id} sid={sid} idea={i} state={state} run={run} />)}
      </ul>
      <AddIdea sid={sid} columnId={col.id} run={run} />
    </div>
  );
}

function AddIdea({ sid, columnId, run }: { sid: string; columnId: number; run: Run }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button class="secondary" onClick={() => setOpen(true)}>+ Add an idea to this column</button>;
  return (
    <IdeaForm
      initial={{ title: "", summary: "", details: "", audience: "", code: "" }}
      submitLabel="Add idea"
      onCancel={() => setOpen(false)}
      onSubmit={(v) => run(async () => { await api.adminAddIdea(sid, { ...v, columnId }); setOpen(false); })}
    />
  );
}

type IdeaFields = { title: string; summary: string; details: string; audience: string; code: string };

function IdeaForm(props: { initial: IdeaFields; submitLabel: string; onSubmit: (v: IdeaFields) => void; onCancel: () => void; extra?: preact.ComponentChildren }) {
  const [v, setV] = useState(props.initial);
  const [uid] = useState(() => ++uidCounter);
  const set = (k: keyof IdeaFields) => (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    setV((prev) => ({ ...prev, [k]: value }));
  };
  const id = (k: string) => `if-${k}-${uid}`;
  return (
    <form class="idea-form" onSubmit={(e) => { e.preventDefault(); props.onSubmit(v); }}>
      <div class="grid3">
        <div class="field"><label for={id("code")}>Code (optional)</label><input id={id("code")} value={v.code} maxLength={8} placeholder="auto" onInput={set("code")} /></div>
        <div class="field"><label for={id("aud")}>Audience tag (optional)</label><input id={id("aud")} value={v.audience} maxLength={40} placeholder="e.g. For managers" onInput={set("audience")} /></div>
        {props.extra}
      </div>
      <div class="field"><label for={id("t")}>Title</label><input id={id("t")} value={v.title} maxLength={120} required onInput={set("title")} /></div>
      <div class="field"><label for={id("s")}>Summary (shown on the card)</label><textarea id={id("s")} rows={2} maxLength={400} value={v.summary} onInput={set("summary")} /></div>
      <div class="field"><label for={id("d")}>Details (shown when someone opens “Details”)</label><textarea id={id("d")} rows={3} maxLength={2000} value={v.details} onInput={set("details")} /></div>
      <div class="row">
        <button class="primary" type="submit" disabled={!v.title.trim()}>{props.submitLabel}</button>
        <button class="secondary" type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function IdeaRow({ sid, idea, state, run }: { sid: string; idea: FacilitatorIdea; state: FacilitatorState; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState("");
  const [columnId, setColumnId] = useState(String(idea.columnId));

  if (editing) {
    return (
      <li class="idea-row">
        <IdeaForm
          initial={{ title: idea.title, summary: idea.summary, details: idea.details, audience: idea.audience, code: idea.code }}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          extra={
            <div class="field">
              <label for={`mv-${idea.id}`}>Column</label>
              <select id={`mv-${idea.id}`} value={columnId} onChange={(e) => setColumnId((e.target as HTMLSelectElement).value)}>
                {state.columns.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
              </select>
            </div>
          }
          onSubmit={(v) => run(async () => { await api.adminEditIdea(sid, idea.id, { ...v, columnId: Number(columnId) }); setEditing(false); })}
        />
      </li>
    );
  }

  return (
    <li class="idea-row">
      <div class="idea-text">
        {idea.code && <strong class="code">{idea.code} </strong>}
        <strong>{idea.title}</strong>
        {idea.audience && <span class="tag"> {idea.audience}</span>}
        {idea.summary && <span class="summary-line"> — {idea.summary}</span>}
        {idea.author && <span class="by"> (suggested by {idea.author})</span>}
      </div>
      <div class="row wrap actions">
        <button class="secondary" onClick={() => setEditing(true)} aria-label={`Edit ${idea.title}`}>Edit</button>
        <button class="secondary" onClick={() => setMerging(!merging)} aria-expanded={merging} aria-label={`Merge ${idea.title} into another idea`}>Merge…</button>
        <button
          class="danger" aria-label={`Delete ${idea.title}`}
          onClick={() => confirm(`Delete "${idea.title}"? Any stars on it go back to the people who used them.`) && run(() => api.adminDeleteIdea(sid, idea.id))}
        >
          Delete
        </button>
      </div>
      {merging && (
        <div class="row merge">
          <label for={`merge-${idea.id}`}>Merge into</label>
          <select id={`merge-${idea.id}`} value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
            <option value="">Choose an idea…</option>
            {state.ideas.filter((o) => o.id !== idea.id).map((o) => <option value={o.id} key={o.id}>{o.code ? `${o.code} ` : ""}{o.title}</option>)}
          </select>
          <button
            class="primary" disabled={!target}
            onClick={() => confirm(`Merge "${idea.title}" into the chosen idea? Its stars move across, and "${idea.title}" is removed.`) && run(() => api.adminMerge(sid, idea.id, Number(target)))}
          >
            Merge
          </button>
        </div>
      )}
    </li>
  );
}

function ImportPanel({ sid, phase, run }: { sid: string; phase: string; run: Run }) {
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
      const r = await api.adminImport(sid, format, content, mode);
      setMessage(`Imported ${r.added} ${r.added === 1 ? "idea" : "ideas"}${r.columnsAdded ? ` and ${r.columnsAdded} new ${r.columnsAdded === 1 ? "column" : "columns"}` : ""}${r.skipped ? `. Skipped ${r.skipped} without a title` : ""}.`);
    });
    input.value = "";
  };

  const download = async () => {
    const data = await api.adminExport(sid);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "board.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section class="panel" aria-labelledby="h-import">
      <h2 id="h-import">Import and export</h2>
      <label for="import-file">Import ideas from CSV or JSON</label>
      <div class="row wrap">
        <input id="import-file" type="file" accept=".csv,.json,text/csv,application/json" onChange={onFile} />
        <label class="inline"><input type="radio" name="mode" checked={mode === "append"} onChange={() => setMode("append")} /> Add to the board</label>
        <label class="inline"><input type="radio" name="mode" checked={mode === "replace"} disabled={phase !== "setup"} onChange={() => setMode("replace")} /> Replace the whole board</label>
      </div>
      <p class="hint">
        CSV needs a header row with <code>title</code>, and optionally <code>column</code>, <code>summary</code>, <code>details</code>, <code>audience</code> and <code>code</code>.
        Columns are created as needed. JSON can also list <code>columns</code> with colors.
      </p>
      {message && <p role="status" class="ok">{message}</p>}
      <p><button class="secondary" onClick={download}>Download this board as JSON</button> <span class="hint">Reuse it as a starting point later. It contains no votes or names.</span></p>
    </section>
  );
}
